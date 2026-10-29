/**
 * 共享运行时的按需安装。
 *
 * 唱歌引擎的派生 venv 以 `<部署根>/runtimes/gpt-sovits/<版本>/<档>/runtime/python.exe`
 * 为 base（`--system-site-packages`，白拿 torch / onnxruntime / librosa）。这份运行时本来由
 * gpt-sovits 插件下载；没装它的时候，这里照同一份清单自己下一份，装好的目录布局与它完全一致
 * （含 `cortico-runtime.json`），三个插件共用同一份，谁先装都一样。
 *
 * DiffSinger 走 onnxruntime 的 CPU provider，torch 也只被库用来算几个小张量，
 * 所以这里固定用 **CPU 档**（约 1 GB），不去碰 4 GB 的显卡档。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export const RUNTIME_ID = 'gpt-sovits';
export const RUNTIME_VERSION = 'e91506f-1';
export const UPSTREAM_COMMIT = 'e91506f1fba265e1841617c3042a1573206a7351';

const MS_OWN = 'https://www.modelscope.cn/models/Phantivia/gpt-sovits-for-coopanion/resolve/master';
const GH_OWN = `https://github.com/Phantivia/cortico-world-gpt-sovits-for-coopanion/releases/download/runtime-${RUNTIME_VERSION}`;
const CPU_FILE = `gpt-sovits-${RUNTIME_VERSION}-win-x64-cpu.zip`;

/** 一个运行时包：整包大小、SHA-256 与按顺序尝试的来源。 */
export interface RuntimeAsset {
  file: string;
  bytes: number;
  sha256: string;
  sources: readonly string[];
}

export const RUNTIME_ASSET: RuntimeAsset = {
  file: CPU_FILE,
  bytes: 1036310624,
  sha256: '9ce348074e941388544b4db072ee0b9cfc50c9bd420e61f13ee9364fe90152e1',
  sources: [`${MS_OWN}/runtime/${CPU_FILE}`, `${GH_OWN}/${CPU_FILE}`],
};

export type RuntimePhase = 'absent' | 'working' | 'ready' | 'error';

export interface RuntimeState {
  phase: RuntimePhase;
  done: number;
  total: number;
  detail: string | null;
}

/** `<运行时根>/gpt-sovits/<版本>/<档>`；布局与 gpt-sovits 插件一致，双方可以互相认领。 */
export function runtimeDir(root: string, tier: string): string {
  return join(root, RUNTIME_ID, RUNTIME_VERSION, tier);
}

/** 这一档装好没有：`runtime/python.exe` 在就算。 */
export function runtimeReady(dir: string): boolean {
  return existsSync(join(dir, 'runtime', 'python.exe'));
}

/** 在运行时根下找已经装好的任一档（别人装的显卡档也算）。 */
export function findRuntimePython(root: string, tiers: readonly string[]): { dir: string; tier: string } | null {
  for (const tier of tiers) {
    const dir = runtimeDir(root, tier);
    if (runtimeReady(dir)) return { dir, tier };
  }
  return null;
}

const PROBE_TIMEOUT_MS = 15_000;

/** Windows 10 起自带 bsdtar，能解 zip；PATH 上靠前的 Git tar 不认 zip，所以写全路径。 */
function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((done, fail) => {
    const child = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`tar 退出码 ${code}：${err.trim().slice(0, 300)}`))));
  });
}

/** 下载一个文件；`resume` 时从已有字节接着下（魔搭签名地址会过期，重试拿到的是新签名）。 */
async function download(url: string, dest: string, progress: (bytes: number) => void, signal: AbortSignal, resume = false): Promise<void> {
  const existing = resume && existsSync(dest) ? statSync(dest).size : 0;
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: existing > 0 ? { range: `bytes=${existing}-` } : undefined,
  });
  if (!res.ok || !res.body) {
    // 416：服务器认为已经下全了，大小校验交给上层。
    if (res.status === 416 && existing > 0) return;
    throw new Error(`HTTP ${res.status}`);
  }
  const append = existing > 0 && res.status === 206;
  if (!append && existing > 0) rmSync(dest, { force: true });
  const out = createWriteStream(dest, { flags: append ? 'a' : 'w' });
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      progress(buf.length);
      if (!out.write(buf)) {
        await new Promise<void>((done) => out.once('drain', done));
      }
    }
  } catch (err) {
    out.destroy();
    throw err;
  }
  await new Promise<void>((done, fail) => { out.end(() => done()); out.once('error', fail); });
}

/** 下载前看一眼目标盘剩余空间：要「下载 + 解压」双份余量，不然会下到 100% 才在解压那步失败。 */
function assertFreeSpace(dir: string, needBytes: number): void {
  try {
    const stats = statfsSync(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const need = Math.ceil(needBytes * 2.2) + 512 * 1024 * 1024;
    if (free < need) {
      const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
      throw new Error(`磁盘空间不足：还要约 ${gb(need)} GB（下载 + 解压），目标盘只剩 ${gb(free)} GB`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('磁盘空间不足')) throw err;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = await import('node:fs').then(({ createReadStream }) => createReadStream(path));
  await new Promise<void>((done, fail) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => done());
    stream.once('error', fail);
  });
  return hash.digest('hex');
}

/**
 * 一件运行时安装任务。`asset` 可注入，测试里用本地小 zip 走完整流程。
 */
export class RuntimeInstall {
  private st: RuntimeState = { phase: 'absent', done: 0, total: 0, detail: null };
  private running: Promise<boolean> | null = null;
  private abort: AbortController | null = null;
  private readonly asset: RuntimeAsset;

  constructor(private readonly opts: {
    root: string;
    tier: string;
    log?: Logger;
    asset?: RuntimeAsset;
  }) {
    this.asset = opts.asset ?? RUNTIME_ASSET;
  }

  dir(): string {
    return runtimeDir(this.opts.root, this.opts.tier);
  }

  ready(): boolean {
    return runtimeReady(this.dir());
  }

  status(): RuntimeState {
    if (this.running) return { ...this.st };
    return this.ready()
      ? { phase: 'ready', done: 0, total: this.asset.bytes, detail: null }
      : { ...this.st, phase: this.st.phase === 'error' ? 'error' : 'absent' };
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** 装一份；已经就绪直接返回 true。 */
  ensure(): Promise<boolean> {
    if (this.running) return this.running;
    if (this.ready()) return Promise.resolve(true);
    this.abort = new AbortController();
    this.st = { phase: 'working', done: 0, total: this.asset.bytes, detail: this.asset.file };
    this.running = this.work(this.abort.signal)
      .then(() => {
        this.st = { phase: 'ready', done: this.asset.bytes, total: this.asset.bytes, detail: null };
        return true;
      })
      .catch((err: unknown) => {
        this.st = {
          ...this.st,
          phase: 'error',
          detail: this.abort?.signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err),
        };
        return false;
      })
      .finally(() => { this.running = null; this.abort = null; });
    return this.running;
  }

  private async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    const archive = join(partial, this.asset.file);
    assertFreeSpace(dir, this.asset.bytes);
    const errors: string[] = [];
    let ok = false;
    for (const url of this.asset.sources) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          // 续传：断点前已下的字节继续用，重试会重新拿一次签名地址。
          this.st.done = existsSync(archive) ? statSync(archive).size : 0;
          await download(url, archive, (n) => { this.st.done += n; }, signal, true);
          if (statSync(archive).size !== this.asset.bytes) throw new Error(`大小 ${statSync(archive).size}，应为 ${this.asset.bytes}`);
          if (await sha256File(archive) !== this.asset.sha256) {
            // 内容坏了：续传没意义，删掉重来。
            rmSync(archive, { force: true });
            throw new Error('SHA-256 不符');
          }
          ok = true;
          break;
        } catch (err) {
          if (signal.aborted) throw err;
          errors.push(`${url}${attempt > 1 ? `（第 ${attempt} 次）` : ''}：${err instanceof Error ? err.message : String(err)}`);
          if (signal.aborted) break;
        }
      }
      if (ok) break;
    }
    if (!ok) throw new Error(errors.slice(-6).join('\n') || '没有下载来源');
    this.st.detail = '正在解压';
    await extract(archive, partial);
    rmSync(archive, { force: true });
    if (!runtimeReady(partial)) {
      throw new Error('压缩包解压后没有 runtime/python.exe，疑似下载或解压不完整；重试仍失败可换「自备运行时」');
    }
    writeFileSync(
      join(partial, 'cortico-runtime.json'),
      JSON.stringify({ id: RUNTIME_ID, version: RUNTIME_VERSION, upstream: UPSTREAM_COMMIT, tier: this.opts.tier }, null, 2),
    );
    this.st.detail = '正在替换运行时目录';
    mkdirSync(join(this.opts.root, RUNTIME_ID, RUNTIME_VERSION), { recursive: true });
    removeDirSafe(dir);
    renameSync(partial, dir);
    this.opts.log?.info('共享运行时已装好', { dir });
  }
}

/** 删除目录；占用或权限问题就抛给上层，别静默把旧运行时弄坏。 */
function removeDirSafe(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY') {
      throw new Error('替换运行时目录失败：文件被占用。先在面板里停掉引擎再重试。');
    }
    throw err;
  }
}

/** 探一次：目录里的 python 能不能跑（版本、依赖都在运行时包内）。 */
export function probeRuntimePython(dir: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const python = join(dir, 'runtime', 'python.exe');
  if (!existsSync(python)) return Promise.resolve(false);
  return new Promise((done) => {
    const child = spawn(python, ['-I', '-c', 'import sys; print(sys.version_info[:2])'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); done(false); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); done(false); });
    child.once('close', (code) => { clearTimeout(timer); done(code === 0); });
  });
}

/** 运行时根下有没有任何可用的档（给面板显示用）。 */
export function installedTiers(root: string): string[] {
  const base = join(root, RUNTIME_ID, RUNTIME_VERSION);
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base).filter((tier) => runtimeReady(join(base, tier)));
  } catch {
    return [];
  }
}
