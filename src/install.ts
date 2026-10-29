/**
 * 模型包的下载与解压安装。
 *
 * 约定：每个文件下到 `<目标>.partial`，字节数与 SHA-256 都对上才改名到位；
 * 中断留下的 `.partial` 下次用 `Range` 续传（服务器不支持就整段重下）。
 * 每个文件按 `sources` 顺序试，前一个失败（网络、HTTP 状态、校验）才试下一个。
 *
 * 解压用派生 venv 里的 Python 标准库 `zipfile`（`.oudep` 也是 zip）：比自己写 ZIP 解析稳，
 * 也不用往包里塞依赖。声库先解到 `<voicebankDir>.partial` 再把 `dsconfig.yaml` 所在目录
 * 整体改名到位；声码器直接解到 `dsvocoder/`。解压成功后删掉 zip 省 451 MB。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  VOCODER_FILE, VOICEBANK_FILE, VOCODER_MARKER, VOICEBANK_MARKER,
  type PinnedFile,
} from './catalog.ts';

export type InstallPhase = 'absent' | 'working' | 'ready' | 'error';

export interface InstallState {
  phase: InstallPhase;
  /** 已落盘字节（含 `.partial`）。 */
  done: number;
  /** 这一批的总字节。 */
  total: number;
  /** 正在下的文件 / 正在解压的包，或失败原因。 */
  detail: string | null;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const sizeOf = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

const entries = (dir: string): string[] => {
  try { return readdirSync(dir); } catch { return []; }
};

/** 文件已在位且大小对（SHA 只在下载完成后校验一次，避免每次启动都哈希几百 MB）。 */
export function hasFile(dir: string, file: PinnedFile): boolean {
  return sizeOf(join(dir, file.path)) === file.bytes;
}

/** 校验失败：数据本身不对，`.partial` 必须扔掉，换下一个来源重下。 */
class VerifyError extends Error {}

/**
 * 把一个地址下到 `dest`；`offset > 0` 时带 `Range` 续传。
 * 服务器忽略 Range（回 200）就截断重下，保证不会把两段数据拼在一起。
 */
async function fetchTo(url: string, dest: string, offset: number, signal: AbortSignal): Promise<void> {
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
  const res = await fetch(url, { signal, redirect: 'follow', headers });
  if (res.status === 416 && offset > 0) return; // 已经下到头，交给调用方校验
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const append = offset > 0 && res.status === 206;
  if (!append && offset > 0) rmSync(dest, { force: true });
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) { done(null, chunk); },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(dest, { flags: append ? 'a' : 'w' }), { signal });
}

/** 按来源顺序下完一个文件；网络中断保留 `.partial` 供下次续传，校验失败则丢弃重来。 */
async function downloadFile(dir: string, file: PinnedFile, signal: AbortSignal): Promise<void> {
  const dest = join(dir, file.path);
  const partial = `${dest}.partial`;
  if (hasFile(dir, file)) return;
  mkdirSync(dirname(dest), { recursive: true });
  const errors: string[] = [];
  for (const url of file.sources) {
    if (signal.aborted) throw new Error('已取消');
    let offset = sizeOf(partial);
    if (offset > file.bytes) { rmSync(partial, { force: true }); offset = 0; }
    try {
      await fetchTo(url, partial, offset, signal);
      const size = sizeOf(partial);
      if (size !== file.bytes) throw new VerifyError(`大小 ${size}，应为 ${file.bytes}`);
      if (await sha256File(partial) !== file.sha256) throw new VerifyError('SHA-256 不符');
      renameSync(partial, dest);
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof VerifyError) rmSync(partial, { force: true });
      errors.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`${file.path} 下载失败：${errors.join('；') || '没有下载来源'}`);
}

/** 一批固定文件的下载任务；进度按磁盘上的字节实时算。 */
export class FileSetJob {
  private state: { phase: InstallPhase; detail: string | null } = { phase: 'absent', detail: null };
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(readonly dir: string, readonly files: readonly PinnedFile[]) {}

  /** 还缺的文件（大小对就算有）。 */
  missing(): PinnedFile[] {
    return this.files.filter((f) => !hasFile(this.dir, f));
  }

  bytes(): number {
    return this.files.reduce((n, f) => n + f.bytes, 0);
  }

  status(): InstallState {
    const total = this.bytes();
    if (this.running) return { phase: 'working', done: this.progress(), total, detail: this.state.detail };
    if (!this.missing().length) return { phase: 'ready', done: total, total, detail: null };
    return { phase: this.state.phase === 'error' ? 'error' : 'absent', done: this.progress(), total, detail: this.state.detail };
  }

  install(): Promise<void> {
    if (this.running) return this.running;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.state = { phase: 'working', detail: null };
    this.running = (async () => {
      for (const file of this.missing()) {
        if (signal.aborted) throw new Error('已取消');
        this.state.detail = file.path;
        await downloadFile(this.dir, file, signal);
      }
      this.state = { phase: 'ready', detail: null };
    })()
      .catch((err: unknown) => {
        this.state = {
          phase: 'error',
          detail: signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err),
        };
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    return this.running;
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** 已落盘字节：完整的算满，未完成的算 `.partial` 大小。 */
  private progress(): number {
    let done = 0;
    for (const file of this.files) {
      if (hasFile(this.dir, file)) { done += file.bytes; continue; }
      done += Math.min(sizeOf(join(this.dir, `${file.path}.partial`)), file.bytes);
    }
    return done;
  }
}

/** 解压超时：420 MB 的声库在机械盘上也就几分钟。 */
const EXTRACT_TIMEOUT_MS = 900_000;

/** 用 Python 标准库把 zip 解开到 `dest`；返回退出码（-1 表示启动失败/超时）。 */
function extractZip(pythonPath: string, zip: string, dest: string, tail: string[]): Promise<number> {
  const code = [
    'import sys, zipfile',
    'zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn(pythonPath, ['-I', '-X', 'utf8', '-c', code, zip, dest], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const push = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) { tail.push(line.trim().slice(0, 240)); if (tail.length > 8) tail.shift(); }
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      resolve(-1);
    }, EXTRACT_TIMEOUT_MS);
    timer.unref();
    child.once('error', (err) => { clearTimeout(timer); push(Buffer.from(err.message)); resolve(-1); });
    child.once('close', (exit) => { clearTimeout(timer); resolve(exit ?? -1); });
  });
}

/** 解压结果里 `dsconfig.yaml` 所在的那一层：根目录，或唯一一层子目录。 */
function voicebankRoot(dir: string): string {
  if (existsSync(join(dir, VOICEBANK_MARKER))) return dir;
  for (const name of entries(dir)) {
    const sub = join(dir, name);
    try {
      if (statSync(sub).isDirectory() && existsSync(join(sub, VOICEBANK_MARKER))) return sub;
    } catch { /* 跳过不可读的项 */ }
  }
  return '';
}

/**
 * 声库与声码器的安装任务，面板只看这一份汇总状态。
 *
 * 顺序：声库 zip（下 + 解压）→ 声库自带 `dsvocoder/` 就跳过声码器包，
 * 否则下 `.oudep` 解到 `dsvocoder/` → 两个标记文件都在才算就绪。
 */
export class SingerInstaller {
  private state: { phase: InstallPhase; detail: string | null } = { phase: 'absent', detail: null };
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private tail: string[] = [];
  /** 声库 zip 的下载任务。 */
  private readonly bank: FileSetJob;
  /** 声码器包的下载任务。 */
  private readonly vocoder: FileSetJob;

  constructor(
    /** zip 落盘目录。 */
    readonly dir: string,
    /** 解压后的声库目录。 */
    readonly voicebankDir: string,
    /** 派生 venv 的 python.exe（解压用标准库 zipfile）。 */
    private readonly pythonPath: () => string,
    private readonly log?: { warn: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void },
  ) {
    this.bank = new FileSetJob(dir, [VOICEBANK_FILE]);
    this.vocoder = new FileSetJob(dir, [VOCODER_FILE]);
  }

  voicebankReady(): boolean {
    return existsSync(join(this.voicebankDir, VOICEBANK_MARKER));
  }

  vocoderReady(): boolean {
    return existsSync(join(this.voicebankDir, VOCODER_MARKER));
  }

  ready(): boolean {
    return this.voicebankReady() && this.vocoderReady();
  }

  status(): InstallState {
    const total = VOICEBANK_FILE.bytes + VOCODER_FILE.bytes;
    if (this.ready()) return { phase: 'ready', done: total, total, detail: null };
    if (this.running) {
      return { phase: 'working', done: this.progress(), total, detail: this.state.detail };
    }
    return {
      phase: this.state.phase === 'error' ? 'error' : 'absent',
      done: this.progress(),
      total,
      detail: this.state.detail,
    };
  }

  install(): Promise<void> {
    if (this.running) return this.running;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.state = { phase: 'working', detail: null };
    this.tail = [];
    this.running = this.run(signal)
      .catch((err: unknown) => {
        this.state = {
          phase: 'error',
          detail: signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err),
        };
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    return this.running;
  }

  cancel(): void {
    this.abort?.abort();
    this.bank.cancel();
    this.vocoder.cancel();
  }

  /** 已落盘字节：两个 zip 各自按 `FileSetJob` 的进度累加（解压期间都算满）。 */
  private progress(): number {
    return this.bank.status().done + this.vocoder.status().done;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const python = this.pythonPath();
    if (!this.ready()) {
      if (!existsSync(python)) throw new Error(`解压需要 Python（${python || '未填'}），先点「一键安装」建派生 venv`);
    }
    // 1. 声库
    if (!this.voicebankReady()) {
      if (this.bank.missing().length) {
        this.state.detail = VOICEBANK_FILE.path;
        await this.bank.install();
        if (this.bank.status().phase !== 'ready') {
          throw new Error(this.bank.status().detail ?? `${VOICEBANK_FILE.path} 下载失败`);
        }
      }
      if (signal.aborted) throw new Error('已取消');
      await this.extractVoicebank(python, signal);
    }
    // 2. 声码器：声库自带的就不装了
    if (!this.vocoderReady()) {
      if (this.vocoder.missing().length) {
        this.state.detail = VOCODER_FILE.path;
        await this.vocoder.install();
        if (this.vocoder.status().phase !== 'ready') {
          throw new Error(this.vocoder.status().detail ?? `${VOCODER_FILE.path} 下载失败`);
        }
      }
      if (signal.aborted) throw new Error('已取消');
      await this.extractVocoder(python, signal);
    }
    // 3. 两个标记都在，才算装完；zip 留着没用，删掉省 451 MB
    if (!this.ready()) throw new Error('装完了但声库标记文件仍然缺失（dsconfig.yaml / dsvocoder/vocoder.yaml）');
    rmSync(join(this.dir, VOICEBANK_FILE.path), { force: true });
    rmSync(join(this.dir, VOCODER_FILE.path), { force: true });
    this.state = { phase: 'ready', detail: null };
    this.log?.info('DiffSinger 声库安装完成', { voicebankDir: this.voicebankDir });
  }

  private async extractVoicebank(python: string, signal: AbortSignal): Promise<void> {
    const zip = join(this.dir, VOICEBANK_FILE.path);
    const tmp = `${this.voicebankDir}.partial`;
    this.state.detail = '解压声库';
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const code = await extractZip(python, zip, tmp, this.tail);
    if (signal.aborted) { rmSync(tmp, { recursive: true, force: true }); throw new Error('已取消'); }
    if (code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`解压声库失败（${code === -1 ? '超时或无法启动' : `退出码 ${code}`}）：${this.tail.slice(-1)[0] ?? '没有输出'}`);
    }
    const source = voicebankRoot(tmp);
    if (!source) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error('声库包里没有 dsconfig.yaml：压缩包结构不对');
    }
    if (entries(this.voicebankDir).length) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`声库目录不是空的：${this.voicebankDir}；清空它或改「声库目录」后再装`);
    }
    rmSync(this.voicebankDir, { recursive: true, force: true });
    mkdirSync(dirname(this.voicebankDir), { recursive: true });
    renameSync(source, this.voicebankDir);
    rmSync(tmp, { recursive: true, force: true });
    this.log?.info('声库已解压', { dir: this.voicebankDir });
  }

  private async extractVocoder(python: string, signal: AbortSignal): Promise<void> {
    const zip = join(this.dir, VOCODER_FILE.path);
    const dest = join(this.voicebankDir, 'dsvocoder');
    this.state.detail = '解压声码器';
    mkdirSync(dest, { recursive: true });
    const code = await extractZip(python, zip, dest, this.tail);
    if (signal.aborted) throw new Error('已取消');
    if (code !== 0) {
      throw new Error(`解压声码器失败（${code === -1 ? '超时或无法启动' : `退出码 ${code}`}）：${this.tail.slice(-1)[0] ?? '没有输出'}`);
    }
    // 有的包里自带一层 `dsvocoder/`，把内容提到当前层。
    if (!existsSync(join(dest, 'vocoder.yaml')) && existsSync(join(dest, 'dsvocoder', 'vocoder.yaml'))) {
      const inner = join(dest, 'dsvocoder');
      for (const name of entries(inner)) renameSync(join(inner, name), join(dest, name));
      rmSync(inner, { recursive: true, force: true });
    }
    if (!existsSync(join(dest, 'vocoder.yaml'))) throw new Error('声码器包里没有 vocoder.yaml：结构不对');
    this.log?.info('声码器已解压', { dir: dest });
  }
}
