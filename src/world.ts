/**
 * DiffSinger 唱歌 World：`kind = world`，做「歌词进、wav 出」，并能在本机把一句唱出来。
 *
 * 挂载时拉起两样东西：
 * 1. 常驻 Python worker（`src/python/worker.py`，见 engine.ts）——载入声库，之后每首歌只走推理；
 * 2. 本机 HTTP 接口（server.ts，默认 127.0.0.1:9882）——给其他插件与外部大模型用。
 *
 * 工具 `singer_sing` 给桌宠 / 对话页用：合成（可选过 RVC）完把 PCM 写进本机声卡才回执，
 * 回执正文就是这句歌词；提示词要求先调它、拿到回执后再 `pet_say` 同一句，气泡与声音一起出现。
 * QQ 点歌仍走 qq_send + voice=true。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import {
  configGroups, DEFAULT_PORT, idleDelayMs, SINGER_ID, worldLabel,
  type SingerConfigSection, type SingerTier,
} from './config.ts';
import { SingerEngine, SingerError, type EngineState } from './engine.ts';
import { SingerInstaller } from './install.ts';
import { rvcPost, waitForRvc } from './rvc.ts';
import { Player, type WavPlayer } from './player.ts';
import { SINGER_TOOL_DECLS } from './tools.ts';
import { parseWavHeader } from './wav.ts';
import {
  LYRICS_MAX, MAX_SECONDS_MAX, MAX_SECONDS_MIN, readSingJob, startSingServer, STEPS_MAX, STEPS_MIN,
  type SingDeps, type SingJob, type SingOutcome, type SingServerHandle,
} from './server.ts';
import { SingerVenv } from './venv.ts';
import { bankInfo, languageLabel, scanBanks, voiceName, type BankInfo } from './banks.ts';
import { RuntimeInstall, installedTiers } from './runtime.ts';
import { panelText } from './webui/text.ts';
import { VOCODER_PAGE, VOICEBANK_PAGE, VOICEBANK_VERSION } from './catalog.ts';

const WORKER_SCRIPT = fileURLToPath(new URL('./python/worker.py', import.meta.url));
/** 告诉模型「在哪唱歌、怎么点歌」的环境提示词模板。 */
const ENV_PROMPT_PATH = fileURLToPath(new URL('../prompts/env.md', import.meta.url));
const VERSION = '0.1.16';
/** `singer_sing` 等这一句唱进声卡的上限：整句批式合成 0.5–11 秒，再加 RVC 最多 20 秒，留足余量。 */
const SING_ALOUD_MAX_MS = 90_000;
/** 换声库时最多等旧引擎把排队的句子唱完（超时也照样切，别把用户卡死）。 */
const SWITCH_DRAIN_MS = 180_000;
/** 桌宠外放时等 RVC 就绪 / 转换的上限：超时就播原声，别把「气泡等声音」一起拖住。 */
const RVC_ALOUD_WAIT_MS = 25_000;
const RVC_ALOUD_CONVERT_MS = 30_000;
/** 接口与面板没有「气泡等着」的压力，可以多等一会儿冷启动。 */
const RVC_HTTP_WAIT_MS = 60_000;
const RVC_HTTP_CONVERT_MS = 180_000;

/** 一次演唱的可选行为；接口与面板走默认值，桌宠外放压短 RVC 的等待。 */
interface SingOptions {
  /** 等 RVC 就绪的上限（毫秒）。 */
  rvcWaitMs?: number;
  /** 单次转换的上限（毫秒）；不传用 rvcPost 的默认值。 */
  rvcTimeoutMs?: number;
}

export interface SingerWorldOptions {
  cfg: SingerConfigSection;
  dataDir: string;
  /** `<部署根>/runtimes`；自动找 gpt-sovits 运行时用。 */
  runtimesRoot: () => string;
  /** 建引擎的工厂；单测里注入假引擎用，不传就按配置建真的 `SingerEngine`。 */
  createEngine?: (init: EngineInit) => SingerEngine;
  /** 建本机播放器；单测里注入假播放器用，不传就用随包 audify 的真播放器。 */
  createPlayer?: (log: Logger) => WavPlayer;
}

export interface EngineInit {
  pythonPath: string;
  voicebankDir: string;
  scriptPath: string;
  runtimeDir?: string;
  device?: 'auto' | 'cpu' | 'cuda';
}

/** 这套运行时带不带 CUDA / cuDNN：torch/lib 里有 cuDNN 9 的 DLL 才算显卡档。 */
function runtimeHasCuda(dir: string): boolean {
  return dir !== '' && existsSync(join(dir, 'runtime', 'Lib', 'site-packages', 'torch', 'lib', 'cudnn64_9.dll'));
}

/** 递归统计目录占用；不跟符号链接（venv 里有 junction，跟进去会绕圈）。 */
function dirBytes(dir: string): number {
  let total = 0;
  const walk = (path: string): void => {
    let names: string[];
    try { names = readdirSync(path); } catch { return; }
    for (const name of names) {
      const next = join(path, name);
      try {
        const st = lstatSync(next);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(next);
        else total += st.size;
      } catch { /* 被占用 / 无权限：跳过 */ }
    }
  };
  walk(dir);
  return total;
}

/** 回执里带的技术细节别太长，气泡要能读。 */
function short(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * RVC 插件包在不在：`<部署数据目录>/extensions/node_modules[/@wocwang]/cortico-world-rvc-for-coopanion`。
 * 由 `runtimesRoot`（`<数据目录>/home/runtimes`）往上两级推；推不出来回 `null`（不猜）。
 */
function rvcPackageInstalled(runtimesRoot: string): boolean | null {
  try {
    const modules = join(dirname(dirname(runtimesRoot)), 'extensions', 'node_modules');
    // 连 extensions/node_modules 都不在：这套部署不是我们能推的布局，别硬说「没装」。
    if (!existsSync(modules)) return null;
    return [
      join(modules, '@wocwang', 'cortico-world-rvc-for-coopanion'),
      join(modules, 'cortico-world-rvc-for-coopanion'),
    ].some((dir) => existsSync(join(dir, 'package.json')));
  } catch {
    return null;
  }
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
  /** 本机播放器：`singer_sing` 把 PCM 写进它；原生模块用到才加载。 */
  private player: WavPlayer | null = null;
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
  /** 引擎是「闲置回收」停的（不是用户手动停服务）：下一条请求要能自动拉回来。 */
  private idleStopped = false;
  /** 用户在面板手动点了「停止服务」：桌宠 / 对话页的调用默认不覆盖这个意图。 */
  private serviceHeld = false;
  private idleTimer: NodeJS.Timeout | undefined;
  /** 正在执行 stop() 的那一小段：请求要等它结束再决定是否拉回。 */
  private idleSleep: Promise<void> | undefined;
  /** 已排队/正在唱的句数：大于 0 时不排闲置回收。 */
  private singBusy = 0;
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
  /** 目录占用缓存：面板每秒拉一次 state，不能每次都去遍历几千个文件。 */
  private readonly bytesCache = new Map<string, { bytes: number; at: number }>();
  /** 最近一次演唱的结果，面板渲染用。 */
  private lastSing: {
    at: number; ms: number; bytes: number; seconds: number; notes: number;
    sungChars: number; savedPath: string | null; bpm: number; keyShift: number; scale: string; rvc: boolean;
    rvcNote: string | null;
  } | null = null;
  /**
   * 对话里说「唱慢一点 / 调高点 / 换小调」时改的值：当次生效，后续句子继续沿用，
   * 直到再改一次。只在内存里，不写配置文件（用户要长期默认仍去设置页）。
   */
  private tune: { bpm?: number; keyShift?: number; scale?: 'major' | 'minor' } = {};

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
    const mouth = this.opts.cfg.mouthAnimation === false
      ? '已关闭：不要调用 pet_say 带动嘴型；歌词放在普通回复里即可。'
      : '已开启：唱完后用 pet_say 显示同一句歌词，气泡会带动嘴型；这一句结束让气泡自然消失，嘴就会闭上。';
    return { 'singer.state': state, 'singer.mouth': mouth };
  }

  tools(): ToolDef[] {
    const decl = SINGER_TOOL_DECLS[0];
    return [{ ...decl, handler: (args) => this.singAloud(args) }];
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
      // 给模型的唱歌写法：QQ 用 qq_send + voice=true；桌宠 / 对话页用 singer_sing，紧跟 pet_say。
      promptDocs: [{
        key: `worlds.${SINGER_ID}.envPrompt`,
        title: `${worldLabel(language)} · 环境提示词`,
        description: 'QQ 点歌用 qq_send + voice=true；桌宠 / 对话页先 singer_sing，等回执后 pet_say 同一句歌词；速度 / 调式 / 移调可以直接在对话里改。',
        path: ENV_PROMPT_PATH,
        role: 'envPrompt',
        vars: [
          { name: 'singer.state', description: '唱歌引擎此刻的状态（就绪 / 启动中 / 出错 / 未启动）。' },
          { name: 'singer.mouth', description: '唱歌时是否用 pet_say 带动嘴型（读配置里的「唱歌时让嘴型动起来」）。' },
        ],
      }],
      // 配置组交给框架自带的配置视图，不各占一个面板。
      config: configGroups(language),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.player = this.opts.createPlayer ? this.opts.createPlayer(host.log) : new Player(host.log);
    this.stopped = false;
    this.serviceHeld = false;
    this.launchDetail = '';
    this.setup();
    // 随 Coopanion 启动就看配置；关掉时插件仍加载，但引擎与接口先不启动，面板随时可以手动开。
    if (this.opts.cfg.autoStart !== false) {
      this.startService();
    } else {
      this.serviceOn = false;
      this.launchDetail = '';
    }
    // 已有的派生 venv 不必等用户点安装：后台探一次，面板直接显示就绪。
    void this.prepareVenvOnStart();
  }

  /**
   * 挂载时后台查一次派生 venv；升级到显卡档后如果缺 `onnxruntime-gpu`，
   * 顺手补装：先停掉已按 CPU 拉起的引擎（pip 覆盖不了 worker 占着的 .pyd/.dll），
   * 装完再按当前配置拉回来。还没有派生 venv 时不动，留给面板「一键安装」。
   */
  private prepareVenvOnStart(): void {
    const venv = this.venv;
    if (!venv) return;
    void venv.check()
      .then(async (st) => {
        if (this.stopped || st.phase !== 'absent') return;
        if (this.opts.cfg.device === 'cpu' || !runtimeHasCuda(this.runtimeDir)) return;
        if (!existsSync(this.pythonPath)) return;
        await this.engine?.stop();
        if (this.stopped) return;
        await venv.ensure();
        if (this.stopped) return;
        if (venv.state().phase === 'ready') this.bootEngine();
      })
      .catch(() => undefined);
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
      // 显卡推理的两块依赖都在显卡档运行时里：GPU 版 onnxruntime 装进派生 venv，
      // CUDA / cuDNN 从运行时的 torch/lib 借；CPU 档运行时没有这些，就不白装 215 MB。
      gpu: this.opts.cfg.device !== 'cpu'
        && (paths.runtimeTier === 'cuda' || runtimeHasCuda(paths.runtimeDir)),
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
      device: this.opts.cfg.device,
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
    this.serviceHeld = false;
    this.idleStopped = false;
    this.launchDetail = '';
    // 手动启停等同一次重试：上次换声库失败的目录可以再试一次。
    this.failedBank = null;
    this.bootEngine();
    if (this.opts.cfg.httpApi && !this.server) void this.startHttp();
  }

  /** 面板「停止服务」：停引擎、关接口；World 仍挂着，下次点「启动服务」再回来。 */
  private async stopService(): Promise<void> {
    this.serviceOn = false;
    this.serviceHeld = true;
    this.idleStopped = false;
    this.cancelIdle();
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
    this.cancelIdle();
    this.player?.cut();
    this.player?.close();
    this.player = null;
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
      .then(() => {
        this.launchDetail = '';
        this.idleStopped = false;
        this.armIdle();
      })
      .catch((err: unknown) => {
        // 面板刚点了「停止服务」就别再记一条失败：引擎是被我们主动停的。
        if (!this.serviceOn) return;
        this.launchDetail = err instanceof Error ? err.message : String(err);
        this.log?.warn('唱歌引擎启动失败', { err: this.launchDetail });
      });
    void this.starting;
  }

  /** 闲置回收：到点停掉引擎。服务关着、正在换声库、还有句子在排队时不排期。 */
  private armIdle(): void {
    this.cancelIdle();
    const delayMs = idleDelayMs(this.opts.cfg.idleMinutes);
    if (!delayMs || this.stopped || !this.serviceOn) return;
    const engine = this.engine;
    if (!engine?.ready() || this.switching) return;
    if (this.singBusy > 0 || engine.queue() > 0) return;
    this.idleTimer = setTimeout(() => { void this.sleepIdle(); }, delayMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** 定时器到点：再确认一次没有活，才真正停引擎；停完不关服务，下一条请求可以自动拉回。 */
  private async sleepIdle(): Promise<void> {
    this.idleTimer = undefined;
    if (this.stopped || !this.serviceOn) return;
    const engine = this.engine;
    if (!engine?.ready() || engine.queue() > 0 || this.switching || this.singBusy > 0) {
      this.armIdle();
      return;
    }
    const done = (async (): Promise<void> => {
      await engine.stop();
      this.idleStopped = true;
      this.launchDetail = '引擎已闲置停止，下一条请求会自动启动';
      this.log?.info('唱歌引擎闲置回收', { idleMinutes: this.opts.cfg.idleMinutes });
    })();
    this.idleSleep = done;
    try {
      await done;
    } finally {
      this.idleSleep = undefined;
    }
  }

  /**
   * 按需拉回：闲置回收、服务开着但引擎停着（含启动时没预热）都能拉起。
   * 手动停服务（serviceOn=false）、未装声库、启动失败保持原有语义，不在这里偷偷重试。
   */
  async ensureReady(timeoutMs = 0): Promise<void> {
    if (this.stopped || !this.serviceOn) return;
    const engine = this.engine;
    if (!engine || engine.ready()) return;
    // 正在执行闲置回收：等 stop() 结束（期间请求排队，不吃 409）。
    if (this.idleSleep) await this.idleSleep.catch(() => undefined);
    // 已经在启动中（自动启动或别的请求触发）：一起等，避免并发请求被 409 打回。
    if (this.starting) await this.waitStarting(timeoutMs);
    if (engine.ready()) return;
    if (engine.state().phase !== 'stopped') return;
    this.idleStopped = false;
    this.bootEngine();
    await this.waitStarting(timeoutMs);
  }

  /** 等引擎启动完成；`timeoutMs>0` 时超时返回错误，后台启动本身继续。 */
  private async waitStarting(timeoutMs: number): Promise<void> {
    const starting = this.starting;
    if (!starting) return;
    if (timeoutMs <= 0) {
      await starting.catch(() => undefined);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        starting.catch(() => undefined),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`engine start took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 桌宠 / 对话页调用前的「先拉起再执行」。
   * 服务是手动停的就不覆盖；随机启动关着、闲置回收、引擎意外停着都会拉起并等就绪。
   */
  async ensureServiceForTool(timeoutMs = 60_000): Promise<{ ok: boolean; reason?: string }> {
    if (this.stopped) return { ok: false, reason: 'the singer world is stopped' };
    if (!this.serviceOn) {
      if (this.serviceHeld) return { ok: false, reason: 'the singing service was stopped manually; start it on the Service page first' };
      this.startService();
    }
    if (this.engine?.ready()) return { ok: true };
    let timeout = '';
    try {
      await this.ensureReady(timeoutMs);
    } catch (err) {
      timeout = err instanceof Error ? err.message : String(err);
    }
    if (this.engine?.ready()) return { ok: true };
    const detail = this.engine?.state().detail || this.launchDetail || timeout;
    return { ok: false, reason: detail || 'the singing engine did not become ready' };
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
      ensureReady: () => this.ensureReady(),
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
        ? `${voiceName(this.activeBank)} [${this.activeBank.languages.join('/')}]${this.activeBank.colors.length ? ` ${this.activeBank.colors.join('/')}` : ''}`
        : `Qixuan v${VOICEBANK_VERSION}`,
      method: 'POST',
      path: '/sing',
      contentType: 'application/json',
      note: '歌词进，wav 出；中文写汉字、日语写假名（需日语声库）、英语写单词（需带英语词典的声库），标点断句，其余字符不唱。旋律按起承转合在所选调式里生成（每句拱形，句末落主音、三音或五度）。配置里换了声库，下一句自动换引擎，不用重启。',
      params: {
        lyrics: { type: 'string', required: true, maxLength: LYRICS_MAX, description: '要唱的歌词，例如「晚风吹过旧时光」；日语写假名，英语用空格分词' },
        bpm: { type: 'integer', default: cfg.bpm, min: 60, max: 200, description: '速度；每字半拍、句末一字一拍' },
        keyShift: { type: 'integer', default: cfg.keyShift, min: -12, max: 12, description: '移调（半音），正数更高' },
        scale: { type: 'string', default: cfg.scale, enum: ['major', 'minor'], description: '旋律调式' },
        seed: { type: 'integer', default: 0, description: '旋律种子；0 表示按歌词固定取值，同一歌词同一条旋律' },
        pitchSteps: { type: 'integer', default: 10, min: STEPS_MIN, max: STEPS_MAX, description: '音高扩散步数，小一点更快' },
        varianceSteps: { type: 'integer', default: 10, min: STEPS_MIN, max: STEPS_MAX, description: '方差扩散步数' },
        acousticSteps: { type: 'integer', default: 40, min: STEPS_MIN, max: STEPS_MAX, description: '声学扩散步数，小一点更快、更糙' },
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
  private sing(job: SingJob, opts: SingOptions = {}): Promise<SingOutcome> {
    // 有活就不回收；唱完再重新计时。
    this.cancelIdle();
    this.singBusy += 1;
    // 串行：同一时刻只唱一句；配置里换了声库，也排在这一句唱完之后再换。
    const run = (): Promise<SingOutcome> => this.singOnce(job, opts);
    const next = this.singChain.then(run, run);
    this.singChain = next.catch(() => undefined);
    return next.finally(() => {
      this.singBusy -= 1;
      this.armIdle();
    });
  }

  /** 桌宠 / 对话页里唱一句：合成完把 PCM 写进本机声卡，起播（或失败）后才回执。 */
  private async singAloud(args: Record<string, unknown>): Promise<ToolOutcome> {
    // 整句批式合成要几秒：给整段一个兜底上限。超时先回「还在准备」，合成不取消，就绪后照常出声。
    const capped = await Promise.race([this.singAloudOnce(args), delayed(SING_ALOUD_MAX_MS)]);
    if (capped) return capped;
    return {
      text: `The line is still being prepared after ${SING_ALOUD_MAX_MS / 1000} s; it will be sung when ready.`,
      failed: true,
    };
  }

  private async singAloudOnce(args: Record<string, unknown>): Promise<ToolOutcome> {
    // 引擎没起（随机启动关着 / 闲置回收 / 意外停着）就先拉起再唱；手动停服务不覆盖。
    const ready = await this.ensureServiceForTool();
    if (!ready.ok) {
      return { text: `No sound: ${ready.reason}.`, failed: true };
    }
    let job: SingJob;
    try {
      // 工具可带 bpm / keyShift / scale（「唱慢一点」「调高点」由模型透传）；
      // 没带就沿用上一次对话里改的值，再没有才用配置。时长压到 30 秒内（桌宠里一句不会太长）。
      job = readSingJob({
        ...args,
        save: false,
        base64: false,
        bpm: args.bpm ?? this.tune.bpm ?? this.opts.cfg.bpm,
        keyShift: args.keyShift ?? this.tune.keyShift ?? this.opts.cfg.keyShift,
        scale: args.scale ?? this.tune.scale ?? this.opts.cfg.scale,
        maxSeconds: 30,
      });
    } catch (err) {
      return { text: `Nothing sung: ${err instanceof Error ? err.message : String(err)}.`, failed: true };
    }
    // 这次显式给了的参数记住，后面的话按新参数唱（用户不必去设置页）。
    if (args.bpm !== undefined) this.tune.bpm = job.bpm;
    if (args.keyShift !== undefined) this.tune.keyShift = job.keyShift;
    if (args.scale !== undefined) this.tune.scale = job.scale;
    let out: SingOutcome;
    try {
      // 外放链路：等 RVC 就绪最多 25 秒、转换 30 秒；超时或失败就播原声，不让这一句卡住。
      out = await this.sing(job, { rvcWaitMs: RVC_ALOUD_WAIT_MS, rvcTimeoutMs: RVC_ALOUD_CONVERT_MS });
    } catch (err) {
      return { text: `Nothing sung: ${err instanceof Error ? err.message : String(err)}.`, failed: true };
    }
    const player = this.player;
    try {
      if (!player) throw new Error('本机播放器未就绪');
      const head = parseWavHeader(out.audio);
      if (!head) throw new Error('输出不是合法的 WAV');
      if (head.channels !== 1 || head.bitsPerSample !== 16) {
        throw new Error(`只支持单声道 16-bit PCM，这一句是 ${head.channels} 声道 / ${head.bitsPerSample}-bit`);
      }
      await player.write(head.sampleRate, out.audio.subarray(head.dataStart));
      player.flush();
    } catch (err) {
      return {
        text: `Sang one line but could not play it on this computer: ${err instanceof Error ? err.message : String(err)}.`,
        failed: true,
      };
    }
    this.log?.info('桌宠里唱了一句', { seconds: out.seconds, ms: out.ms, bytes: out.audio.length, rvc: out.rvc });
    // 回执正文就是这一句歌词：模型原样交给 pet_say，气泡内容与这次唱的一致，
    // 而且此刻第一块 PCM 已经进了声卡输出流，气泡不会跑到声音前面。
    // RVC 没换成时补一句短说明（没装 / 没运行 / 超时 / 转换失败），不让它静默退回原声。
    return { text: out.rvcNote ? `${job.lyrics}\n（${out.rvcNote}）` : job.lyrics };
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

  /** 没等到 RVC 能转换时，回执里怎么讲清是哪一种：超时 / 令牌 / 已安装没运行 / 没装。 */
  private rvcDownReason(endpoint: string, reason: 'timeout' | 'down', waitMs: number, detail: string): string {
    if (reason === 'timeout') return `RVC 启动超时（${Math.round(waitMs / 1000)} 秒内未就绪）`;
    if (detail.includes('401')) return 'RVC 接口要求令牌（或令牌不匹配）';
    const installed = rvcPackageInstalled(this.opts.runtimesRoot());
    if (installed === true) return 'RVC 已安装但接口没响应（插件没启用或关了 HTTP 接口）';
    if (installed === false) return 'RVC 未安装';
    return `RVC 没在运行（${endpoint} 无响应）`;
  }

  private async singOnce(job: SingJob, opts: SingOptions = {}): Promise<SingOutcome> {
    if (!this.serviceOn) throw new SingerError('unavailable', '推理服务未启动：在「服务」页点「启动服务」');
    // 闲置回收后第一次唱：先把它拉回来（服务仍是开着的）。
    await this.ensureReady();
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
      let rvcNote: string | undefined;
      if (this.opts.cfg.rvcEnabled) {
        const endpoint = this.opts.cfg.rvcEndpoint;
        const waitMs = opts.rvcWaitMs ?? RVC_HTTP_WAIT_MS;
        // RVC 插件挂载时就会开始载入引擎；先等 /health 的 ready，而不是直接 POST 吃 409。
        const ready = await waitForRvc(endpoint, { budgetMs: waitMs });
        if (!ready.ok) {
          rvcNote = `${this.rvcDownReason(endpoint, ready.reason, waitMs, ready.detail)}，本次用绮萱原声`;
          this.log?.warn('RVC 没就绪，本次用绮萱原声', { endpoint, reason: ready.reason, waitedMs: ready.waitedMs });
        } else {
          const converted = await rvcPost(audio, {
            endpoint,
            voice: this.opts.cfg.rvcVoice,
            // RVC 的变调跟演唱的移调走，听听换完音色后的音高是否还自然。
            pitch: job.keyShift,
            indexRate: this.opts.cfg.rvcIndexRate,
            protect: this.opts.cfg.rvcProtect,
            timeoutMs: opts.rvcTimeoutMs ?? RVC_HTTP_CONVERT_MS,
          });
          // 外放链路的要求是「RVC 失败也照样有声音」：换不出来、或者换出来的
          // 不是单声道 16-bit PCM，都退回干声，这一句不中断。
          const head = converted.ok ? parseWavHeader(converted.audio) : null;
          if (converted.ok && head && head.channels === 1 && head.bitsPerSample === 16) {
            audio = converted.audio;
            rvc = true;
          } else if (converted.ok) {
            rvcNote = 'RVC 返回的音频不是单声道 16-bit，本次用绮萱原声';
            this.log?.warn('RVC 返回的音频不是单声道 16-bit，本次用绮萱原声', { endpoint });
          } else {
            rvcNote = `RVC 转换失败（${short(converted.detail)}），本次用绮萱原声`;
            this.log?.warn('RVC 后处理失败，本次用绮萱原声', { endpoint, detail: converted.detail });
          }
        }
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
        rvcNote: rvcNote ?? null,
      };
      return {
        audio,
        sampleRate: done.sampleRate,
        seconds: done.seconds,
        notes: done.notes,
        sungChars: done.sungChars,
        ms: this.lastSing.ms,
        rvc,
        rvcNote,
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
    if (method === 'remove') return this.removeModel(args[0]);
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
        ? { name: this.activeBank.name, label: voiceName(this.activeBank), languages: this.activeBank.languages, colors: this.activeBank.colors }
        : null,
      banksDir: this.banksDir,
      banks: scanBanks(this.banksDir).map((bank) => ({
        name: bank.name,
        label: voiceName(bank),
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
      // 面板表单的初值：对话里改过速度 / 调式 / 移调的话，这里也跟着变。
      defaults: {
        bpm: this.tune.bpm ?? this.opts.cfg.bpm,
        keyShift: this.tune.keyShift ?? this.opts.cfg.keyShift,
        scale: this.tune.scale ?? this.opts.cfg.scale,
      },
      rvc: { enabled: this.opts.cfg.rvcEnabled, endpoint: this.opts.cfg.rvcEndpoint, voice: this.opts.cfg.rvcVoice },
      lastSing: this.lastSing,
      models: this.modelInventory(),
      version: VERSION,
      voicebankPage: VOICEBANK_PAGE,
    };
  }

  /**
   * 已安装模型的清单：面板列出来，让用户看到每样占多少、能清多少。
   * 只有声库、派生 venv 与临时音频属于本插件；共享运行时三个插件共用，只读不删。
   */
  private modelInventory(): {
    voicebank: { path: string; bytes: number; ready: boolean };
    venv: { path: string; bytes: number; ready: boolean };
    runtime: { path: string; bytes: number; tier: string | null; shared: boolean };
    tmp: { path: string; bytes: number };
    reclaimable: number;
  } {
    const voicebankDir = this.voicebankDir;
    const venvDir = this.venvRootDir();
    const tmpDir = join(this.opts.dataDir, 'tmp');
    const voicebankBytes = voicebankDir ? this.cachedBytes(voicebankDir) : 0;
    const venvBytes = this.cachedBytes(venvDir);
    const tmpBytes = this.cachedBytes(tmpDir);
    const runtimeBytes = this.runtimeDir ? this.cachedBytes(this.runtimeDir) : 0;
    return {
      voicebank: { path: voicebankDir, bytes: voicebankBytes, ready: !!this.activeBank },
      venv: { path: venvDir, bytes: venvBytes, ready: this.venv?.state().phase === 'ready' },
      runtime: {
        path: this.runtimeDir,
        bytes: runtimeBytes,
        tier: this.runtimeTier || null,
        shared: true,
      },
      tmp: { path: tmpDir, bytes: tmpBytes },
      reclaimable: voicebankBytes + venvBytes + tmpBytes,
    };
  }

  /** 派生 venv 根目录：`Scripts/python.exe` 往上两级。 */
  private venvRootDir(): string {
    return dirname(dirname(this.pythonPath));
  }

  private cachedBytes(dir: string): number {
    const hit = this.bytesCache.get(dir);
    if (hit && Date.now() - hit.at < 60_000) return hit.bytes;
    const bytes = dirBytes(dir);
    this.bytesCache.set(dir, { bytes, at: Date.now() });
    return bytes;
  }

  /** 面板点「卸载」：删声库 / 派生 venv / 临时音频；删完返回新状态。 */
  private async removeModel(raw: unknown): Promise<unknown> {
    const target = typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).target === 'string'
        ? (raw as { target: string }).target
        : '';
    if (!['voicebank', 'venv', 'tmp'].includes(target)) return { error: `未知的卸载目标：${target || '空'}` };
    const busy = this.installer?.status().phase === 'working'
      || this.venv?.state().phase === 'working'
      || this.runtime?.status().phase === 'working';
    if (busy) return { error: '有安装任务正在进行：先取消，再卸载' };
    // worker 占着 venv 里的 .pyd/.dll 与声库目录，先停掉再删。
    await this.engine?.stop();
    try {
      if (target === 'voicebank') {
        const dir = this.voicebankDir;
        if (!dir || !existsSync(dir)) return { error: '声库目录已经是空的' };
        if (!existsSync(join(dir, 'dsconfig.yaml'))) {
          return { error: `拒绝卸载：${dir} 里没有 dsconfig.yaml，不像声库目录` };
        }
        rmSync(dir, { recursive: true, force: true });
        this.activeBank = bankInfo(dir);
        this.failedBank = null;
        this.bytesCache.delete(dir);
        this.log?.info('已卸载声库', { dir });
      } else if (target === 'venv') {
        const root = this.venvRootDir();
        if (!existsSync(join(root, 'pyvenv.cfg'))) {
          return { error: `拒绝卸载：${root} 里没有 pyvenv.cfg，不像派生 venv` };
        }
        rmSync(root, { recursive: true, force: true });
        this.bytesCache.delete(root);
        this.log?.info('已卸载派生 venv', { dir: root });
        // venv 状态归零，engine 也换成新的（旧的已停）；面板下一步会提示重新安装。
        this.setup();
      } else {
        const dir = join(this.opts.dataDir, 'tmp');
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        this.bytesCache.delete(dir);
        this.log?.info('已清理临时音频', { dir });
      }
      return this.status();
    } catch (err) {
      return { error: `卸载失败：${err instanceof Error ? err.message : String(err)}` };
    }
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
    this.serviceHeld = false;
    this.idleStopped = false;
    this.cancelIdle();
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
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new SingerError('unavailable', engine.state().detail ?? '唱歌引擎未就绪');
    }
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

/** 等 `ms` 毫秒后给出 `null`，给一段等待加个上限；不拖住进程退出。 */
const delayed = (ms: number): Promise<null> => new Promise((resolve) => {
  setTimeout(() => resolve(null), ms).unref();
});

const silentLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => silentLogger,
};
