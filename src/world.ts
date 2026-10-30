/**
 * DiffSinger 唱歌 World：`kind = world`，只做「歌词进、wav 出」。
 *
 * 挂载时拉起两样东西：
 * 1. 常驻 Python worker（`src/python/worker.py`，见 engine.ts）——载入声库，之后每首歌只走推理；
 * 2. 本机 HTTP 接口（server.ts，默认 127.0.0.1:9882）——给其他插件与外部大模型用。
 *
 * 本 World 不注册工具、不发事件：文字由 gpt-sovits 管，QQ 消息由 QQ 插件管。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  configGroups, DEFAULT_PORT, SINGER_ID, worldLabel,
  type SingerConfigSection, type SingerTier,
} from './config.ts';
import { SingerEngine, SingerError, type EngineState } from './engine.ts';
import { SingerInstaller } from './install.ts';
import { rvcPost } from './rvc.ts';
import {
  LYRICS_MAX, MAX_SECONDS_MAX, MAX_SECONDS_MIN, readSingJob, startSingServer, STEPS_MAX, STEPS_MIN,
  type SingDeps, type SingJob, type SingOutcome, type SingServerHandle,
} from './server.ts';
import { SingerVenv } from './venv.ts';
import { bankInfo, languageLabel, scanBanks, type BankInfo } from './banks.ts';
import { RuntimeInstall, installedTiers } from './runtime.ts';
import { panelText } from './webui/text.ts';
import { VOCODER_PAGE, VOICEBANK_PAGE, VOICEBANK_VERSION } from './catalog.ts';

const WORKER_SCRIPT = fileURLToPath(new URL('./python/worker.py', import.meta.url));
/** 告诉模型「在 QQ 里怎么点歌」的环境提示词模板。 */
const ENV_PROMPT_PATH = fileURLToPath(new URL('../prompts/env.md', import.meta.url));
const VERSION = '0.1.12';
/** 换声库时最多等旧引擎把排队的句子唱完（超时也照样切，别把用户卡死）。 */
const SWITCH_DRAIN_MS = 180_000;

export interface SingerWorldOptions {
  cfg: SingerConfigSection;
  dataDir: string;
  /** `<部署根>/runtimes`；自动找 gpt-sovits 运行时用。 */
  runtimesRoot: () => string;
  /** 建引擎的工厂；单测里注入假引擎用，不传就按配置建真的 `SingerEngine`。 */
  createEngine?: (init: EngineInit) => SingerEngine;
}

export interface EngineInit {
  pythonPath: string;
  voicebankDir: string;
  scriptPath: string;
  runtimeDir?: string;
}

/** 配置 → 实际使用的声库目录：选了「声库总目录」里的某个库就用它，否则用单独的「声库目录」。 */
export function resolveVoicebankDir(
  cfg: Pick<SingerConfigSection, 'voicebank' | 'voicebankDir' | 'voicebanksDir'>,
  dataDir: string,
): string {
  const banksDir = cfg.voicebanksDir.trim() || join(dataDir, 'voicebanks');
  return cfg.voicebank.trim()
    ? join(banksDir, cfg.voicebank.trim())
    : cfg.voicebankDir.trim() || join(dataDir, 'voicebank');
}

/** 在 `<runtimesRoot>/gpt-sovits/<版本>/<档>/runtime/python.exe` 里挑一个可用运行时。
 *  `auto`/`cuda` 优先 CUDA 档（auto 没有 CUDA 运行时则回退 CPU），`cpu` 只用 CPU 档。 */
export function findRuntimeDir(
  runtimesRoot: string,
  preferred: SingerTier = 'auto',
): { dir: string; tier: 'cuda' | 'cpu' } {
  const root = join(runtimesRoot, 'gpt-sovits');
  const fallback: { dir: string; tier: 'cuda' | 'cpu' } = { dir: '', tier: preferred === 'cpu' ? 'cpu' : 'cuda' };
  if (!existsSync(root)) return fallback;
  let versions: string[] = [];
  try { versions = readdirSync(root); } catch { return fallback; }
  const order: Array<'cuda' | 'cpu'> = preferred === 'cpu' ? ['cpu'] : ['cuda', 'cpu'];
  const ranked = versions.map((version) => {
    let time = 0;
    for (const tier of order) {
      try { time = Math.max(time, statSync(join(root, version, tier, 'cortico-runtime.json')).mtimeMs); } catch {
        try { time = Math.max(time, statSync(join(root, version, tier)).mtimeMs); } catch { /* 未装这一档 */ }
      }
    }
    return { version, time };
  }).sort((a, b) => b.time - a.time);
  for (const { version } of ranked) {
    for (const tier of order) {
      const dir = join(root, version, tier);
      if (existsSync(join(dir, 'runtime', 'python.exe'))) return { dir, tier };
    }
  }
  return fallback;
}

export class SingerWorld implements World {
  readonly id = SINGER_ID;
  private readonly opts: SingerWorldOptions;
  private log: Logger | null = null;
  private engine: SingerEngine | null = null;
  private installer: SingerInstaller | null = null;
  private venv: SingerVenv | null = null;
  /** 共享运行时（gpt-sovits 的 CPU 档）——没有就自己下一份，三个插件共用。 */
  private runtime: RuntimeInstall | null = null;
  private runtimesRoot = '';
  private server: SingServerHandle | null = null;
  private starting: Promise<void> | null = null;
  private stopped = true;
  /** 推理服务（引擎 + 本机接口）是否开着：面板可以手动停掉（还内存），World 仍挂载。 */
  private serviceOn = false;
  private launchDetail = '';
  private pythonPath = '';
  private runtimeDir = '';
  private voicebankDir = '';
  /** 声库总目录（面板列候选用）。 */
  private banksDir = '';
  /** 当前生效声库的信息（名称 / 语言 / 音色）；目录里没有 dsconfig.yaml 时为 null。 */
  private activeBank: BankInfo | null = null;
  /** 实际用的运行时档（`''` 表示自备运行时，判断不了）。 */
  private runtimeTier: 'cuda' | 'cpu' | '' = '';
  /** 正在换声库：新引擎载入中的目标目录名。 */
  private pendingBank = '';
  private switching = false;
  /** 换声库失败的原因（面板显示，旧引擎继续用）。 */
  private bankSwitchError = '';
  /** 上次换声库失败的目录：配置还指它就别每句都白等几秒再重试。 */
  private failedBank: { dir: string; detail: string } | null = null;
  /** 演唱串行链：同一时刻只唱一句，换声库也排在这一句唱完之后。 */
  private singChain: Promise<unknown> = Promise.resolve();
  /** 最近一次演唱的结果，面板渲染用。 */
  private lastSing: {
    at: number; ms: number; bytes: number; seconds: number; notes: number;
    sungChars: number; savedPath: string | null; bpm: number; keyShift: number; scale: string; rvc: boolean;
  } | null = null;

  constructor(opts: SingerWorldOptions) {
    this.opts = opts;
  }

  envPromptVars(): Record<string, string> {
    const st = this.engine?.state();
    const state = st?.phase === 'ready'
      ? '就绪'
      : st?.phase === 'starting'
        ? '正在启动（载入声库）'
        : st?.phase === 'error'
          ? `出错：${st.detail || this.launchDetail || '未知原因'}`
          : '未启动（在「服务」页点「启动服务」）';
    return { 'singer.state': state };
  }

  tools(): [] {
    return [];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const st = this.engine?.state();
    const t = panelText(language);
    const lamp: WorldLamp = {
      label: 'SING',
      state: st?.phase === 'ready' ? 'online' : st?.phase === 'starting' ? 'loading' : st?.phase === 'error' ? 'error' : 'offline',
      hint: this.launchDetail || st?.detail || undefined,
    };
    return {
      label: worldLabel(language),
      lamps: [lamp],
      panels: [
        { id: 'service', title: t.serviceTitle, description: t.serviceHint, getMethods: ['state'] },
        { id: 'sing', title: t.singTitle, description: t.singHint, getMethods: ['state'] },
      ],
      invoke: async (panel, method, args) => this.invoke(panel, method, args),
      // 告诉模型 QQ 里怎么点歌：qq_send + voice=true + 正文以【唱】开头。
      promptDocs: [{
        key: `worlds.${SINGER_ID}.envPrompt`,
        title: `${worldLabel(language)} · 环境提示词`,
        description: '在 QQ 里点歌的写法：qq_send 传 voice=true，正文以「【唱】」开头。',
        path: ENV_PROMPT_PATH,
        role: 'envPrompt',
        vars: [{ name: 'singer.state', description: '唱歌引擎此刻的状态（就绪 / 启动中 / 出错 / 未启动）。' }],
      }],
      // 配置组交给框架自带的配置视图，不各占一个面板。
      config: configGroups(language),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.stopped = false;
    this.launchDetail = '';
    this.setup();
    // 挂载时默认拉起推理服务；面板上可以手动停掉再启回来（例如省内存）。
    this.startService();
    // 已有的派生 venv 不必等用户点安装：后台探一次，面板直接显示就绪。
    void this.venv?.check();
  }

  /** 按当前配置解析路径并（重）建 installer / venv / engine；改推理档后重启引擎会再走一遍。 */
  private setup(): void {
    const paths = this.paths();
    this.pythonPath = paths.pythonPath;
    this.runtimeDir = paths.runtimeDir;
    this.runtimeTier = paths.runtimeTier;
    this.voicebankDir = paths.voicebankDir;
    this.banksDir = paths.banksDir;
    this.activeBank = bankInfo(paths.voicebankDir);
    this.runtimesRoot = paths.runtimesRoot;
    this.runtime = new RuntimeInstall({ root: paths.runtimesRoot, tier: 'cpu', log: this.log ?? undefined });
    this.installer = new SingerInstaller(paths.dataDir, paths.voicebankDir, () => this.pythonPath, this.log ?? undefined);
    this.venv = new SingerVenv({
      pythonPath: paths.pythonPath,
      basePython: paths.runtimeDir ? join(paths.runtimeDir, 'runtime', 'python.exe') : '',
      log: this.log ?? undefined,
    });
    // 重启/重新解析路径后，上次换声库的失败记录一并清掉（下一句会重新试一次）。
    this.failedBank = null;
    this.bankSwitchError = '';
    this.pendingBank = '';
    this.switching = false;
    this.engine = this.buildEngine(paths.voicebankDir);
  }

  /** 按当前 python / 运行时建一个引擎；单测用注入的工厂，生产里就是 `SingerEngine`。 */
  private buildEngine(voicebankDir: string): SingerEngine {
    const init: EngineInit = {
      pythonPath: this.pythonPath,
      voicebankDir,
      scriptPath: WORKER_SCRIPT,
      runtimeDir: this.runtimeDir || undefined,
    };
    if (this.opts.createEngine) return this.opts.createEngine(init);
    return new SingerEngine({ ...init, log: this.log ?? undefined });
  }

  /**
   * 面板「启动服务」：拉起常驻引擎；接口开着就同时监听。
   * 引擎已经就绪时什么也不做；刚从「停止服务」回来时会重新走一遍载入（约 4–11 秒）。
   */
  private startService(): void {
    if (this.stopped) return;
    this.serviceOn = true;
    this.launchDetail = '';
    // 手动启停等同一次重试：上次换声库失败的目录可以再试一次。
    this.failedBank = null;
    this.bootEngine();
    if (this.opts.cfg.httpApi && !this.server) void this.startHttp();
  }

  /** 面板「停止服务」：停引擎、关接口；World 仍挂着，下次点「启动服务」再回来。 */
  private async stopService(): Promise<void> {
    this.serviceOn = false;
    const server = this.server;
    this.server = null;
    await server?.close();
    await this.engine?.stop();
    this.launchDetail = '';
    this.bankSwitchError = '';
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.serviceOn = false;
    this.installer?.cancel();
    this.venv?.cancel();
    const server = this.server;
    this.server = null;
    await server?.close();
    await this.engine?.stop();
    this.engine = null;
    await this.starting?.catch(() => undefined);
    this.starting = null;
  }

  /** 拉起/重拉引擎；失败原因进 `launchDetail`，面板与接口据此解释。服务关着时不起。 */
  private bootEngine(): void {
    if (!this.serviceOn) return;
    const engine = this.engine;
    if (!engine) return;
    this.starting = engine.start()
      .then(() => { this.launchDetail = ''; })
      .catch((err: unknown) => {
        // 面板刚点了「停止服务」就别再记一条失败：引擎是被我们主动停的。
        if (!this.serviceOn) return;
        this.launchDetail = err instanceof Error ? err.message : String(err);
        this.log?.warn('唱歌引擎启动失败', { err: this.launchDetail });
      });
    void this.starting;
  }

  /** 面板/接口共用：此刻引擎状态。 */
  health(): { ready: boolean; device: string | null; voicebank: string | null; sampleRate: number | null; speakers: string[] } {
    const st = this.engine?.state();
    return {
      ready: !!this.engine?.ready(),
      device: st?.device ?? null,
      voicebank: st?.voicebank ?? null,
      sampleRate: st?.sampleRate ?? null,
      speakers: st?.speakers ?? [],
    };
  }

  private paths(): {
    dataDir: string; pythonPath: string; runtimeDir: string;
    runtimeTier: 'cuda' | 'cpu' | ''; voicebankDir: string; banksDir: string; runtimesRoot: string;
  } {
    const dataDir = this.opts.dataDir;
    const runtimesRoot = this.opts.runtimesRoot();
    // 自备运行时判断不了档位；托管运行时按配置的推理档挑（auto 优先 CUDA）。
    const own = this.opts.cfg.runtimeDir.trim();
    const picked = own
      ? { dir: own, tier: '' as const }
      : findRuntimeDir(runtimesRoot, this.opts.cfg.tier);
    return {
      dataDir,
      runtimesRoot,
      pythonPath: this.opts.cfg.pythonPath.trim() || join(dataDir, 'venv', 'Scripts', 'python.exe'),
      runtimeDir: picked.dir,
      runtimeTier: picked.tier,
      // 声库：选了「声库总目录」里的某个库就用它，否则沿用单独的「声库目录」。
      // 解压后的绮萱声库约 451 MB，首次在面板里安装。
      banksDir: this.opts.cfg.voicebanksDir.trim() || join(dataDir, 'voicebanks'),
      voicebankDir: resolveVoicebankDir(this.opts.cfg, dataDir),
    };
  }

  private async startHttp(): Promise<void> {
    const deps: SingDeps = {
      ready: () => !!this.engine?.ready(),
      stateText: () => this.engine?.state().detail ?? (this.launchDetail || '唱歌引擎启动中'),
      health: () => this.health(),
      sing: (job) => this.sing(job),
      schema: () => this.schema(),
      log: this.log ?? silentLogger,
    };
    try {
      const handle = await startSingServer({
        port: this.opts.cfg.httpPort || DEFAULT_PORT,
        token: this.opts.cfg.httpToken,
        deps,
      });
      if (this.stopped || !this.serviceOn) { await handle.close(); return; }
      this.server = handle;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log?.warn('唱歌接口没能监听', { port: this.opts.cfg.httpPort, err: why });
      this.launchDetail = `接口监听失败（${this.opts.cfg.httpPort}）：${why}`;
    }
  }

  /** `GET /sing` 的自描述文档：外部大模型读这一个就能拼出请求。 */
  private schema(): Record<string, unknown> {
    const cfg = this.opts.cfg;
    const port = this.server?.port ?? cfg.httpPort ?? DEFAULT_PORT;
    return {
      name: 'DiffSinger 唱歌',
      version: VERSION,
      voicebank: this.activeBank
        ? `${this.activeBank.label} [${this.activeBank.languages.join('/')}]${this.activeBank.colors.length ? ` ${this.activeBank.colors.join('/')}` : ''}`
        : `Qixuan v${VOICEBANK_VERSION}`,
      method: 'POST',
      path: '/sing',
      contentType: 'application/json',
      note: '歌词进，wav 出；中文写汉字、日语写假名（需日语声库）、英语写单词（需带英语词典的声库），标点断句，其余字符不唱。旋律由程序按调式自动生成。配置里换了声库，下一句自动换引擎，不用重启。',
      params: {
        lyrics: { type: 'string', required: true, maxLength: LYRICS_MAX, description: '要唱的歌词，例如「晚风吹过旧时光」；日语写假名，英语用空格分词' },
        bpm: { type: 'integer', default: cfg.bpm, min: 60, max: 200, description: '速度；每字半拍、句末一字一拍' },
        keyShift: { type: 'integer', default: cfg.keyShift, min: -12, max: 12, description: '移调（半音），正数更高' },
        scale: { type: 'string', default: cfg.scale, enum: ['major', 'minor'], description: '旋律调式' },
        seed: { type: 'integer', default: 0, description: '旋律种子；0 表示按歌词固定取值，同一歌词同一条旋律' },
        pitchSteps: { type: 'integer', default: 10, min: STEPS_MIN, max: STEPS_MAX, description: '音高扩散步数，小一点更快' },
        varianceSteps: { type: 'integer', default: 10, min: STEPS_MIN, max: STEPS_MAX, description: '方差扩散步数' },
        acousticSteps: { type: 'integer', default: 20, min: STEPS_MIN, max: STEPS_MAX, description: '声学扩散步数，小一点更快、更糙' },
        gender: { type: 'number', default: 0, min: -1, max: 1, description: '音色性别参数，−1 偏男、1 偏女' },
        maxSeconds: { type: 'number', default: 60, min: MAX_SECONDS_MIN, max: MAX_SECONDS_MAX, description: '最长时长，超出就截断乐句' },
        speaker: { type: 'string', default: cfg.voiceColor || '', description: '音色（声库自带，如 Normal / Soft）；留空用配置里的默认音色' },
        save: { type: 'boolean', default: false, description: '另存到插件数据目录，响应头 x-singer-saved 给出路径' },
        base64: { type: 'boolean', default: false, description: '改为回 JSON（含 audioBase64），适合不方便处理二进制的调用方' },
      },
      response: {
        default: 'audio/wav，响应头 x-singer-ms / x-singer-seconds / x-singer-sample-rate / x-singer-notes / x-singer-rvc',
        base64: 'application/json：{ ok, sampleRate, seconds, ms, notes, sungChars, rvc, savedPath, audioBase64 }',
      },
      errors: { 400: '参数错误', 401: '令牌不对', 409: '引擎未就绪（声库未装 / 正在启动）', 502: '推理失败', 503: '队列满' },
      example: {
        curl: `curl -sS -X POST http://127.0.0.1:${port}/sing -H "content-type: application/json" -d "{\\"lyrics\\":\\"晚风吹过旧时光\\",\\"bpm\\":96}" -o sing.wav`,
        json: { lyrics: '晚风吹过旧时光', bpm: 96, keyShift: 0, scale: 'major' },
      },
      usage: { voicebank: VOICEBANK_PAGE, vocoder: VOCODER_PAGE },
    };
  }

  /** 一次演唱：临时 wav 进、内存 wav 出；`save=1` 时另存到 `<dataDir>/out`。 */
  private sing(job: SingJob): Promise<SingOutcome> {
    // 串行：同一时刻只唱一句；配置里换了声库，也排在这一句唱完之后再换。
    const run = (): Promise<SingOutcome> => this.singOnce(job);
    const next = this.singChain.then(run, run);
    this.singChain = next.catch(() => undefined);
    return next;
  }

  /** 配置里的声库变了就地重建引擎；音色每句现读，不用重启。 */
  private async ensureBank(): Promise<void> {
    if (this.stopped || !this.serviceOn || !this.engine) return;
    const target = resolveVoicebankDir(this.opts.cfg, this.opts.dataDir);
    if (!target || target === this.voicebankDir) return;
    // 这个目录刚失败过：配置没再改就不要再白等几秒重试，直接沿用旧声库继续唱。
    if (this.failedBank?.dir === target) return;
    await this.switchEngine(target);
  }

  /** 换声库：新引擎载入就绪后才替换旧的，失败就停掉新的、继续用上一个（唱歌不挂）。 */
  private async switchEngine(dir: string): Promise<void> {
    const old = this.engine;
    const name = basename(dir);
    this.switching = true;
    this.pendingBank = name;
    this.bankSwitchError = '';
    let next: SingerEngine | null = null;
    try {
      // 旧引擎还在唱就先等它唱完（world 里已经串行，这里兜住别处直接调引擎的情况）。
      await drain(old);
      if (!this.serviceOn) return;
      next = this.buildEngine(dir);
      await next.start();
      if (this.stopped || !this.serviceOn) { await next.stop(); return; }
      this.engine = next;
      this.voicebankDir = dir;
      this.activeBank = bankInfo(dir);
      this.launchDetail = '';
      // 新引擎就绪期间服务被手动停了：别把新引擎留在后台。
      if (this.stopped || !this.serviceOn) { await next.stop(); return; }
      this.log?.info('唱歌引擎换声库完成', { voicebank: name, ms: next.state().startMs });
      await old?.stop();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.failedBank = { dir, detail: why };
      this.bankSwitchError = `换声库失败（${name}）：${why}`;
      this.log?.warn('换声库失败，继续用上一个声库', { voicebank: name, err: why });
      await next?.stop().catch(() => undefined);
    } finally {
      this.switching = false;
      this.pendingBank = '';
    }
  }

  private async singOnce(job: SingJob): Promise<SingOutcome> {
    if (!this.serviceOn) throw new SingerError('unavailable', '推理服务未启动：在「服务」页点「启动服务」');
    await this.ensureBank();
    const engine = this.engine;
    if (!engine) throw new SingerError('unavailable', '唱歌引擎未启动');
    const tmpDir = join(this.opts.dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const dry = join(tmpDir, `${randomUUID()}.wav`);
    const at = Date.now();
    try {
      const done = await engine.sing({
        out: dry,
        lyrics: job.lyrics,
        bpm: job.bpm,
        keyShift: job.keyShift,
        scale: job.scale,
        seed: job.seed,
        pitchSteps: job.pitchSteps,
        varianceSteps: job.varianceSteps,
        acousticSteps: job.acousticSteps,
        gender: job.gender,
        maxSeconds: job.maxSeconds,
        // 接口没指定音色时用配置里的默认音色（声库自带的 Normal / Soft…）。
        speaker: job.speaker || this.opts.cfg.voiceColor.trim() || undefined,
      });
      let audio: Buffer = readFileSync(dry);
      let rvc = false;
      if (this.opts.cfg.rvcEnabled) {
        const converted = await rvcPost(audio, {
          endpoint: this.opts.cfg.rvcEndpoint,
          voice: this.opts.cfg.rvcVoice,
          // RVC 的变调跟演唱的移调走，听听换完音色后的音高是否还自然。
          pitch: job.keyShift,
          indexRate: this.opts.cfg.rvcIndexRate,
          protect: this.opts.cfg.rvcProtect,
        });
        if (converted) { audio = converted; rvc = true; }
        else this.log?.warn('RVC 后处理没成功，本次用绮萱原声', { endpoint: this.opts.cfg.rvcEndpoint });
      }
      let savedPath: string | undefined;
      if (job.save) {
        const outDir = join(this.opts.dataDir, 'out');
        mkdirSync(outDir, { recursive: true });
        savedPath = join(outDir, `sing-${stamp()}.wav`);
        writeFileSync(savedPath, audio);
      }
      this.lastSing = {
        at,
        ms: Date.now() - at,
        bytes: audio.length,
        seconds: done.seconds,
        notes: done.notes,
        sungChars: done.sungChars,
        savedPath: savedPath ?? null,
        bpm: job.bpm,
        keyShift: job.keyShift,
        scale: job.scale,
        rvc,
      };
      return {
        audio,
        sampleRate: done.sampleRate,
        seconds: done.seconds,
        notes: done.notes,
        sungChars: done.sungChars,
        ms: this.lastSing.ms,
        rvc,
        savedPath,
      };
    } finally {
      rmSync(dry, { force: true });
    }
  }

  private async invoke(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    if (method === 'state' || method === 'install' || method === 'cancel' || method === 'restart' || method === 'start' || method === 'stop') {
      if (method === 'install') this.startSetup();
      else if (method === 'cancel') { this.runtime?.cancel(); this.installer?.cancel(); this.venv?.cancel(); }
      else if (method === 'restart') void this.restartEngine();
      else if (method === 'start') this.startService();
      else if (method === 'stop') await this.stopService();
      return this.status();
    }
    if (method === 'sing') return this.singFromPanel(args);
    return { error: `unknown method: ${panel}.${method}` };
  }

  /** 面板与状态行看到的一切。 */
  private status(): Record<string, unknown> {
    const st: EngineState | null = this.engine ? this.engine.state() : null;
    const installer = this.installer;
    return {
      phase: st?.phase ?? 'stopped',
      ready: this.health().ready,
      /** 推理服务开着没有：面板据此切换「启动服务 / 停止服务」按钮。 */
      service: this.serviceOn,
      device: st?.device ?? null,
      voicebank: st?.voicebank ?? null,
      sampleRate: st?.sampleRate ?? null,
      speakers: st?.speakers ?? [],
      startMs: st?.startMs ?? null,
      queue: this.engine?.queue() ?? 0,
      // 换声库的进度与结果：`pendingBank` 是新引擎载入中的目标，失败时 `switchError` 给原因。
      switching: this.switching,
      pendingBank: this.pendingBank || null,
      switchError: this.bankSwitchError || null,
      port: this.server?.port ?? null,
      detail: st?.detail ?? this.launchDetail,
      tail: this.engine?.output() ?? [],
      tier: this.opts.cfg.tier,
      runtimeTier: this.runtimeTier,
      pythonPath: this.pythonPath,
      runtimeDir: this.runtimeDir,
      voicebankDir: this.voicebankDir,
      voicebankName: this.voicebankDir ? basename(this.voicebankDir) : '',
      bank: this.activeBank
        ? { name: this.activeBank.name, label: this.activeBank.label, languages: this.activeBank.languages, colors: this.activeBank.colors }
        : null,
      banksDir: this.banksDir,
      banks: scanBanks(this.banksDir).map((bank) => ({
        name: bank.name,
        label: bank.label,
        languages: bank.languages,
        colors: bank.colors,
        active: bank.name === (this.activeBank?.name ?? ''),
      })),
      voiceColor: this.opts.cfg.voiceColor.trim() || this.activeBank?.colors[0] || '',
      voicebankReady: installer?.voicebankReady() ?? false,
      vocoderReady: installer?.vocoderReady() ?? false,
      venv: this.venv?.state() ?? { phase: 'absent', detail: 'World 未启动' },
      runtime: this.runtime?.status() ?? null,
      runtimeTiers: installedTiers(this.runtimesRoot),
      install: installer?.status() ?? { phase: 'absent', done: 0, total: 0, detail: 'World 未启动' },
      // 面板表单的初值，跟配置里的默认值一致。
      defaults: { bpm: this.opts.cfg.bpm, keyShift: this.opts.cfg.keyShift, scale: this.opts.cfg.scale },
      rvc: { enabled: this.opts.cfg.rvcEnabled, endpoint: this.opts.cfg.rvcEndpoint, voice: this.opts.cfg.rvcVoice },
      lastSing: this.lastSing,
      version: VERSION,
      voicebankPage: VOICEBANK_PAGE,
    };
  }

  /** 面板点「一键安装」：先停引擎，再（缺的话）下共享运行时、建派生 venv、补依赖、下声库，装完自动重拉引擎。 */
  private startSetup(): void {
    const installer = this.installer;
    const venv = this.venv;
    if (!installer || !venv) return;
    if (venv.state().phase === 'working' || installer.status().phase === 'working') return;
    void (async () => {
      // worker 在跑时会占住 venv 里的 .pyd/.dll，pip 覆盖不了这些文件；先停掉再装。
      await this.engine?.stop();
      if (this.stopped) return;
      // 没用自备运行时、部署里也没有 gpt-sovits 运行时：自己下一份 CPU 档（约 1 GB），
      // 布局和 gpt-sovits 装的一模一样，三个插件共用同一份，谁先装都一样。
      const runtime = this.runtime;
      if (runtime && !runtime.ready() && !this.opts.cfg.runtimeDir.trim()) {
        const ok = await runtime.ensure();
        if (this.stopped) return;
        if (!ok) {
          this.log?.warn('共享运行时没装成，先不建派生 venv', { detail: runtime.status().detail });
          return;
        }
        // 运行时到位了：重新解析 base 路径，venv / engine 都指向新目录。
        this.setup();
      }
      await this.venv?.ensure();
      if (this.stopped) return;
      if (this.venv?.state().phase !== 'ready') {
        this.log?.warn('DiffSinger 依赖没装好，先不下载声库', { detail: this.venv?.state().detail });
        return;
      }
      await installer.install();
      if (this.stopped) return;
      const state = installer.status();
      this.log?.info('DiffSinger 声库安装结束', { phase: state.phase, detail: state.detail });
      if (state.phase === 'ready' && this.serviceOn && !this.engine?.ready()) this.bootEngine();
    })();
  }

  private async restartEngine(): Promise<void> {
    if (this.stopped) return;
    // 点「重启引擎」就等于要把服务开着：停了也能从这里启回来。
    this.serviceOn = true;
    await this.engine?.stop();
    if (this.stopped) return;
    // 接口的端口 / 令牌 / 开关可能一起改过：先关掉，按当前配置重新监听。
    const server = this.server;
    this.server = null;
    await server?.close();
    // 可能改过推理档/运行时/声库目录：按当前配置重建 venv 与引擎（venv 的 base 变了会自动重建）。
    this.setup();
    if (this.opts.cfg.httpApi) void this.startHttp();
    const venv = this.venv;
    if (!venv) return;
    await venv.check();
    if (this.stopped) return;
    if (venv.state().phase === 'ready') {
      this.bootEngine();
      return;
    }
    // 切了推理档或依赖没装：重建派生 venv，装完再拉起引擎，面板能看到「安装中」。
    void venv.ensure().then(() => {
      if (!this.stopped && venv.state().phase === 'ready') this.bootEngine();
    });
  }

  /** 面板里唱一次：走和 HTTP 接口同一套参数校验，回 `$binary` 让浏览器直接试听。 */
  private async singFromPanel(args: unknown[]): Promise<unknown> {
    const raw = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
    if (!this.serviceOn) throw new SingerError('unavailable', '推理服务未启动：先在「服务」页点「启动服务」');
    const engine = this.engine;
    if (!engine) throw new SingerError('unavailable', '唱歌引擎未启动');
    // 先按接口同一套规则校验参数，填错了立刻能看到原因。
    let job: SingJob;
    try {
      job = readSingJob({ ...raw, save: false, base64: false });
    } catch (err) {
      throw new SingerError('param', err instanceof Error ? err.message : String(err));
    }
    if (!engine.ready()) throw new SingerError('unavailable', engine.state().detail ?? '唱歌引擎未就绪');
    const out = await this.sing(job);
    return { $binary: { mime: 'audio/wav', base64: out.audio.toString('base64') } };
  }
}

/** 等旧引擎把排队的句子唱完；最多等 `SWITCH_DRAIN_MS`，超时也照样切（别把用户卡死）。 */
async function drain(engine: SingerEngine | null): Promise<void> {
  if (!engine) return;
  const deadline = Date.now() + SWITCH_DRAIN_MS;
  while (engine.queue() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** `20261027-193000`。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const silentLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => silentLogger,
};
