/**
 * 本机声卡播放：整句 PCM 落成临时 WAV，交给系统自带的播放器（Windows 用 PowerShell 的
 * SoundPlayer，macOS 用 afplay）在**独立子进程**里播，一句接一句排队。
 *
 * 为什么不用 audify：Coopanion 的多个 World 跑在同一个 Electron 主进程里，gpt-sovits
 * 也随包带了一份 `audify.node`。同一个 N-API 模块在同一个 environment 里注册第二次时
 * `node::AddEnvironmentCleanupHook` 断言 `result.second` 失败，整个进程 exit 134——
 * 桌宠会整只消失、过一会儿像刚启动一样落回来，就是主进程被 abort 后重启。
 * 走子进程播放后，本插件不再往主进程里加载任何原生模块。
 *
 * `flush()` 等播放器报「已开始」才返回，气泡与声音仍然同时开始；`cut()` 杀掉子进程，
 * 队列里没播的也一并丢掉。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

/** 软限幅的拐点：绝对值超过它的样本按 tanh 压到满幅以内。 */
const KNEE = 24000;

/** 等播放器报「started」的上限：PowerShell 冷启动通常 0.2–0.6 秒。 */
const START_TIMEOUT_MS = 8_000;

/** 乘增益；超过拐点的部分平滑压缩，不硬削顶。 */
export function applyGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  const room = 32767 - KNEE;
  for (let at = 0; at + 1 < pcm.length; at += 2) {
    const y = pcm.readInt16LE(at) * gain;
    const mag = Math.abs(y);
    const v = mag <= KNEE ? y : Math.sign(y) * (KNEE + room * Math.tanh((mag - KNEE) / room));
    out.writeInt16LE(Math.round(v), at);
  }
  return out;
}

/** 单声道 PCM16 → 标准 44 字节头的 WAV；播放器只吃文件，拼一份最稳。 */
export function wavFromPcm(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const head = Buffer.alloc(44);
  const blockAlign = channels * 2;
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * blockAlign, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** 工具 handler 只用这个接口；单测里换成假播放器。 */
export interface WavPlayer {
  /** 把这一句 PCM 攒起来（不阻塞）。 */
  write(sampleRate: number, pcm: Buffer, gain?: number): Promise<void>;
  /** 交给播放器，等它真的开始出声才返回。 */
  flush(): Promise<void>;
  /** 立刻停下，丢掉没播的部分。 */
  cut(): void;
  /** 停掉并清空。 */
  close(): void;
}

interface Item {
  file: string;
  dir: string;
  seconds: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class Player implements WavPlayer {
  private pcm: Buffer[] = [];
  private rate = 0;
  private queue: Item[] = [];
  private child: ChildProcess | null = null;
  private pumping = false;

  constructor(private readonly log: Logger) {}

  async write(sampleRate: number, raw: Buffer, gain = 1): Promise<void> {
    // 采样率变了说明不是同一句：把上一句停掉再攒新的。
    if (this.rate && sampleRate !== this.rate) this.cut();
    this.rate = sampleRate;
    this.pcm.push(applyGain(raw, gain));
  }

  async flush(): Promise<void> {
    const pcm = Buffer.concat(this.pcm);
    this.pcm = [];
    if (!pcm.length) return;
    const rate = this.rate || 44_100;
    const dir = mkdtempSync(join(tmpdir(), 'singer-play-'));
    const file = join(dir, 'line.wav');
    writeFileSync(file, wavFromPcm(pcm, rate));
    const seconds = pcm.length / 2 / rate;
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ file, dir, seconds, resolve, reject });
      void this.pump();
    });
  }

  cut(): void {
    for (const item of this.queue.splice(0)) {
      try { rmSync(item.dir, { recursive: true, force: true }); } catch { /* 被占用就算了 */ }
      // 这一句不会再播；别让等 flush 的调用方一直卡着。
      item.resolve();
    }
    this.pcm = [];
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (err) { this.log.warn('停止播放失败', { err: String(err) }); }
    }
  }

  close(): void {
    this.cut();
    this.rate = 0;
  }

  /** 一句一句播；队列空了就退出，下一次 flush 再启动。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        try {
          await this.play(item);
        } catch (err) {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          try { rmSync(item.dir, { recursive: true, force: true }); } catch { /* 播放器可能还占着 */ }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 播一句：子进程报 `started` 就 resolve 调用方，等它退出再轮到下一句。 */
  private play(item: Item): Promise<void> {
    return new Promise<void>((done, fail) => {
      const { cmd, args } = this.command(item.file, item.seconds);
      let child: ChildProcess;
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;
      let said = false;
      let out = '';
      const timer = setTimeout(() => {
        if (said) return;
        said = true;
        fail(new Error(`播放器 ${START_TIMEOUT_MS / 1000} 秒内没有开始出声`));
        try { child.kill(); } catch { /* 已退出 */ }
      }, START_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (said || !out.includes('started')) return;
        said = true;
        clearTimeout(timer);
        this.log.debug('本机播放已开始', { seconds: item.seconds });
        item.resolve();
      });
      const settle = (err?: Error): void => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (!said) {
          said = true;
          fail(err ?? new Error('播放器没开始出声就退出了'));
          return;
        }
        done();
      };
      child.once('error', (err) => settle(err));
      child.once('close', () => settle());
    });
  }

  /** Windows 用 PowerShell 的 SoundPlayer，macOS 用 afplay。 */
  private command(file: string, seconds: number): { cmd: string; args: string[] } {
    if (process.platform === 'darwin') return { cmd: '/usr/bin/afplay', args: [file] };
    const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const escaped = file.replace(/'/g, "''");
    // Play() 是异步的：先 Play 再报 started；进程靠 Start-Sleep 陪到整句播完。
    const script = [
      `$p = New-Object Media.SoundPlayer '${escaped}'`,
      '$p.Load()',
      '$p.Play()',
      "[Console]::Out.WriteLine('started')",
      '[Console]::Out.Flush()',
      `Start-Sleep -Milliseconds ${Math.max(500, Math.round(seconds * 1000) + 500)}`,
    ].join('; ');
    return { cmd: ps, args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script] };
  }
}
