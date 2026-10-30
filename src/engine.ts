/**
 * 常驻 DiffSinger 推理 worker（`src/python/worker.py`）的 Node 侧控制器。
 *
 * worker 是**常驻**子进程：启动时载入声库（dur / pitch / variance / acoustic / vocoder 五个 ONNX），
 * 之后每来一条请求只读一行 JSON、写一行 JSON——不必每条都付模型加载的冷启动。
 *
 * 协议（stdin/stdout 各一行 JSON，UTF-8 无缓冲）：
 * - worker → engine：`{"type":"ready","voicebank":"...","sampleRate":44100,"speakers":[...]}`
 * - worker → engine：`{"type":"result","id":1,"ok":true,"ms":123,"seconds":4.2,"notes":16,"sungChars":16,"sampleRate":44100}`
 * - worker → engine：`{"type":"result","id":1,"ok":false,"kind":"param|infer","error":"..."}`
 * - engine → worker：`{"op":"sing","id":1,"out":"...","lyrics":"...","bpm":96,...}`
 * - engine → worker：`{"op":"shutdown"}`
 * worker 的日志一律走 stderr，stdout 只放协议行。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export class SingerError extends Error {
  constructor(readonly kind: 'param' | 'infer' | 'unavailable', message: string) {
    super(message);
    this.name = 'SingerError';
  }
}

export interface EngineOptions {
  /** 派生 venv 的 python.exe。 */
  pythonPath: string;
  /** 解压后的声库目录（含 `dsconfig.yaml` 与 `dsvocoder/`）。 */
  voicebankDir: string;
  /** worker.py 的绝对路径。 */
  scriptPath: string;
  /** base 运行时目录，只为把它的 `runtime` 与 `torch/lib` 放进 PATH（CUDA / cuDNN 依赖）。 */
  runtimeDir?: string;
  /** 推理设备：`auto` 由 worker 探测 CUDA provider，`cpu` / `cuda` 强制指定。 */
  device?: 'auto' | 'cpu' | 'cuda';
  /** 单次演唱上限；超时杀 worker 并报推理失败。 */
  timeoutMs?: number;
  /** 启动到就绪（含载入声库）的上限。 */
  startTimeoutMs?: number;
  log?: Logger;
}

export type EnginePhase = 'stopped' | 'starting' | 'ready' | 'error';

export interface EngineState {
  phase: EnginePhase;
  device: string | null;
  voicebank: string | null;
  sampleRate: number | null;
  speakers: string[];
  pid: number | null;
  detail: string | null;
  startMs: number | null;
}

export interface SingRequest {
  /** 输出 wav 的路径（由调用方给临时文件）。 */
  out: string;
  lyrics: string;
  bpm: number;
  keyShift: number;
  scale: 'major' | 'minor';
  seed: number;
  pitchSteps: number;
  varianceSteps: number;
  acousticSteps: number;
  /** 音色性别参数，−1 男性、1 女性、0 不变。 */
  gender: number;
  /** 最长时长（秒），超过就截断乐句。 */
  maxSeconds: number;
  /** 音色（声库自带的说话人短名，如 Normal / Soft）；空为第一个。 */
  speaker?: string;
}

export interface SingDone {
  ms: number;
  seconds: number;
  notes: number;
  sungChars: number;
  sampleRate: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_START_TIMEOUT_MS = 300_000;
const TAIL_LINES = 40;

interface Pending {
  resolve: (done: SingDone) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class SingerEngine {
  private child: ChildProcess | null = null;
  private st: EngineState = {
    phase: 'stopped', device: null, voicebank: null, sampleRate: null, speakers: [],
    pid: null, detail: null, startMs: null,
  };
  private tail: string[] = [];
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** 就绪前的启动等待者。 */
  private readyWaiters: { resolve: () => void; reject: (err: Error) => void } | null = null;
  /** worker 输出的残行缓冲。 */
  private buf = '';
  /** 串行链：一次只让 worker 唱一条（单 GPU / 单进程）。 */
  private tailChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: EngineOptions) {}

  state(): EngineState {
    return { ...this.st, speakers: [...this.st.speakers] };
  }

  /** 最近若干行输出，面板/日志用。 */
  output(): string[] {
    return [...this.tail];
  }

  ready(): boolean {
    return this.st.phase === 'ready' && this.child !== null;
  }

  /** 正在处理的请求数（含排队）。 */
  queue(): number {
    return this.pending.size;
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.st.phase === 'ready') return Promise.resolve();
    this.starting = (async () => {
      if (this.stopping) await this.stopping;
      await this.launch();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.readyWaiters?.reject(new SingerError('unavailable', '唱歌引擎已停止'));
    this.readyWaiters = null;
    this.failPending(new SingerError('unavailable', '唱歌引擎已停止'));
    const child = this.child;
    this.child = null;
    this.st = {
      phase: 'stopped', device: null, voicebank: null, sampleRate: null, speakers: [],
      pid: null, detail: null, startMs: null,
    };
    if (!child?.pid || child.exitCode !== null) return;
    const done = new Promise<void>((finish) => {
      child.once('exit', () => finish());
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      setTimeout(finish, 5000).unref();
    });
    this.stopping = done;
    try {
      await done;
    } finally {
      if (this.stopping === done) this.stopping = null;
    }
  }

  /** 唱一条；引擎未就绪时抛 `unavailable`，worker 报参数问题为 `param`，其余为 `infer`。 */
  async sing(req: SingRequest): Promise<SingDone> {
    if (!this.ready()) throw new SingerError('unavailable', this.st.detail ?? '唱歌引擎未就绪');
    const id = ++this.seq;
    const run = () => new Promise<SingDone>((resolve, reject) => {
      const child = this.child;
      if (!child?.stdin?.writable) { reject(new SingerError('unavailable', '唱歌 worker 已退出')); return; }
      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SingerError('infer', `唱歌超过 ${Math.round(timeoutMs / 1000)} 秒`));
        void this.stop();
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({
        op: 'sing', id,
        out: req.out,
        lyrics: req.lyrics,
        bpm: req.bpm,
        keyShift: req.keyShift,
        scale: req.scale,
        seed: req.seed,
        pitchSteps: req.pitchSteps,
        varianceSteps: req.varianceSteps,
        acousticSteps: req.acousticSteps,
        gender: req.gender,
        maxSeconds: req.maxSeconds,
        speaker: req.speaker ?? '',
      });
      try {
        child.stdin.write(`${line}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new SingerError('infer', err instanceof Error ? err.message : String(err)));
      }
    });
    const next = this.tailChain.then(run, run);
    this.tailChain = next.catch(() => undefined);
    return next;
  }

  private async launch(): Promise<void> {
    const started = Date.now();
    this.tail = [];
    this.buf = '';
    this.st = {
      phase: 'starting', device: null, voicebank: null, sampleRate: null, speakers: [],
      pid: null, detail: null, startMs: null,
    };
    const python = this.opts.pythonPath;
    const script = this.opts.scriptPath;
    const fail = (msg: string): never => {
      this.st = { ...this.st, phase: 'error', detail: msg };
      throw new SingerError('unavailable', msg);
    };
    // spawn 的 ENOENT 也可能只是 cwd 不存在（Node 不区分），先把前提逐一说清楚。
    if (!existsSync(python)) fail(`Python 解释器不存在：${python}（在面板点「一键安装」重建依赖）`);
    if (!existsSync(script)) fail(`worker.py 不存在：${script}（重装唱歌插件）`);
    if (!existsSync(join(this.opts.voicebankDir, 'dsconfig.yaml'))) {
      fail(`声库目录里没有 dsconfig.yaml：${this.opts.voicebankDir}（在面板点「一键安装」下载声库）`);
    }
    const child = spawn(python, [script, this.opts.voicebankDir, this.opts.device ?? 'auto'], {
      cwd: dirname(script),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        // 声库里的 character.txt 之类是 UTF-8，Windows 默认按 GBK 打开会直接抛解码错误；强制 UTF-8 模式。
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        // 代码目录在扩展包里，别在里面写 __pycache__。
        PYTHONDONTWRITEBYTECODE: '1',
        PATH: this.searchPath(),
      },
    });
    this.child = child;
    this.st = { ...this.st, phase: 'starting', pid: child.pid ?? null };
    child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr!.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.on('error', (err) => this.onExit(child, `启动失败：${err.message}`));
    child.on('exit', (code) => this.onExit(child, `唱歌 worker 退出（${code}）`));

    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiters = { resolve, reject };
      const timer = setTimeout(() => {
        if (this.child !== child || this.st.phase !== 'starting') return;
        reject(new SingerError('unavailable', `唱歌 worker ${Math.round((this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS) / 1000)} 秒内没有就绪`));
        void this.stop();
      }, this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      timer.unref();
    });
    try {
      await ready;
      this.st = { ...this.st, phase: 'ready', startMs: Date.now() - started };
      this.opts.log?.info('唱歌引擎就绪', { voicebank: this.st.voicebank, sampleRate: this.st.sampleRate, ms: this.st.startMs });
    } catch (err) {
      this.st = { ...this.st, phase: 'error', detail: err instanceof Error ? err.message : String(err) };
      this.opts.log?.warn('唱歌引擎没能就绪', { err: this.st.detail, tail: this.tail.slice(-5) });
      throw err;
    }
  }

  private searchPath(): string {
    const dirs = [dirname(this.opts.pythonPath)];
    if (this.opts.runtimeDir) {
      dirs.push(join(this.opts.runtimeDir, 'runtime'));
      // onnxruntime-gpu 的 CUDA / cuDNN 依赖住在 torch/lib（只有显卡档运行时才有）。
      dirs.push(join(this.opts.runtimeDir, 'runtime', 'Lib', 'site-packages', 'torch', 'lib'));
    }
    return [...dirs, process.env.PATH ?? ''].join(';');
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let at = this.buf.indexOf('\n');
    while (at >= 0) {
      const line = this.buf.slice(0, at).trim();
      this.buf = this.buf.slice(at + 1);
      if (line) this.onLine(line);
      at = this.buf.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.pushTail(line);
      return;
    }
    if (msg.type === 'ready') {
      this.st = {
        ...this.st,
        device: typeof msg.device === 'string' ? msg.device : null,
        voicebank: typeof msg.voicebank === 'string' && msg.voicebank ? msg.voicebank : null,
        sampleRate: typeof msg.sampleRate === 'number' ? msg.sampleRate : null,
        speakers: Array.isArray(msg.speakers) ? msg.speakers.filter((s): s is string => typeof s === 'string') : [],
      };
      const waiter = this.readyWaiters;
      this.readyWaiters = null;
      waiter?.resolve();
      return;
    }
    if (msg.type === 'fatal') {
      // worker 启动即失败（声库结构不对、缺声码器）：立刻报错，不等到超时。
      const why = typeof msg.error === 'string' && msg.error ? msg.error : '唱歌 worker 启动失败';
      this.st = { ...this.st, phase: 'error', detail: why };
      const waiter = this.readyWaiters;
      this.readyWaiters = null;
      waiter?.reject(new SingerError('unavailable', why));
      return;
    }
    if (msg.type === 'result') {
      const id = typeof msg.id === 'number' ? msg.id : -1;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve({
          ms: typeof msg.ms === 'number' ? msg.ms : 0,
          seconds: typeof msg.seconds === 'number' ? msg.seconds : 0,
          notes: typeof msg.notes === 'number' ? msg.notes : 0,
          sungChars: typeof msg.sungChars === 'number' ? msg.sungChars : 0,
          sampleRate: typeof msg.sampleRate === 'number' ? msg.sampleRate : 0,
        });
      } else {
        const kind = msg.kind === 'param' ? 'param' : 'infer';
        pending.reject(new SingerError(kind, typeof msg.error === 'string' && msg.error ? msg.error : '唱歌推理失败'));
      }
      return;
    }
    this.pushTail(line);
  }

  private onStderr(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) this.pushTail(line.trim());
    }
  }

  private pushTail(line: string): void {
    this.tail.push(line.slice(0, 300));
    if (this.tail.length > TAIL_LINES) this.tail.shift();
    this.opts.log?.debug('singer worker', { line: line.slice(0, 300) });
  }

  private onExit(child: ChildProcess, detail: string): void {
    if (this.child !== child) return;
    this.child = null;
    const reason = this.st.detail ? `（${this.st.detail}）` : '';
    const err = new SingerError('unavailable', `${detail}${reason}：${this.tail.slice(-3).join(' | ') || '无输出'}`);
    if (this.st.phase === 'starting') {
      this.st = { ...this.st, phase: 'error', detail: err.message };
      const waiter = this.readyWaiters;
      this.readyWaiters = null;
      waiter?.reject(err);
    } else {
      this.st = { ...this.st, phase: 'error', detail: err.message };
    }
    this.failPending(err);
  }

  private failPending(err: SingerError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
