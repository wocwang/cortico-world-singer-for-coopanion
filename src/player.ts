/**
 * 本机声卡播放：PCM16 单声道经 audify(RtAudio，Windows 上走 WASAPI)按到达顺序写进一条输出流。
 * 设备用系统默认、满音量：本插件不做设备与音量配置。
 *
 * audify 的输出队列无界、`write()` 不阻塞，所以写得进就按顺序播；`cut()` 关流丢弃队列里没播的部分。
 * 播完时刻按写入的帧数换算墙钟，只用来报「正在出声」。
 */
import { createRequire } from 'node:module';
import type { Logger } from 'cortico/core/types.ts';

interface RtAudioLike {
  openStream(
    out: { deviceId: number; nChannels: number; firstChannel: number },
    input: null,
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: null,
    frameOutputCallback: null,
  ): void;
  closeStream(): void;
  start(): void;
  write(buf: Buffer): void;
  getDevices(): Array<{ id: number; name: string; outputChannels: number }>;
  getDefaultOutputDevice(): number;
  isStreamOpen(): boolean;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number };
}

/** 每次写入的帧长：20 ms。 */
const FRAME_MS = 20;

/** 软限幅的拐点：绝对值超过它的样本按 tanh 压到满幅以内。 */
const KNEE = 24000;

/** 打开输出流时用的名字，只在 RtAudio 的日志里出现。 */
const STREAM_NAME = 'cortico-world-singer';

/** 单声道 PCM16 复制成 `channels` 路交错。 */
export function upmix(mono: Buffer, channels: number): Buffer {
  if (channels === 1) return mono;
  const out = Buffer.alloc(mono.length * channels);
  for (let i = 0, o = 0; i + 1 < mono.length; i += 2) {
    for (let c = 0; c < channels; c++, o += 2) {
      out[o] = mono[i]!;
      out[o + 1] = mono[i + 1]!;
    }
  }
  return out;
}

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

/** Windows 上指定 WASAPI：RtAudio 自选时会先挑 ASIO，厂商 ASIO 驱动不认请求的帧长。 */
const apiOf = (a: AudifyModule): number | undefined => (process.platform === 'win32' ? a.RtAudioApi.WINDOWS_WASAPI : undefined);

/**
 * 用到时才加载原生模块：随包带 audify 官方 napi-v10 win32-x64 预编译件（`vendor/audify/`），
 * 不装 npm 的 audify（它安装时去 GitHub 下预编译件，下不到就现场编译）。
 * 枚举值取自 audify 的 index.js。
 */
function loadAudify(): AudifyModule {
  const binding = createRequire(import.meta.url)('../vendor/audify/audify.node') as Pick<AudifyModule, 'RtAudio'>;
  return { RtAudio: binding.RtAudio, RtAudioFormat: { RTAUDIO_SINT16: 0x2 }, RtAudioApi: { WINDOWS_WASAPI: 7 } };
}

/** 工具 handler 只用这个接口；单测里换成假播放器。 */
export interface WavPlayer {
  /** 把这一句 PCM 排进输出流；第一帧写进去就返回（不等整句播完）。 */
  write(sampleRate: number, pcm: Buffer, gain?: number): Promise<void>;
  /** 补上不足一帧的尾巴。 */
  flush(): void;
  /** 立刻停下，丢掉没播的部分。 */
  cut(): void;
  /** 关掉输出流。 */
  close(): void;
}

export class Player implements WavPlayer {
  private audify: AudifyModule | null = null;
  private rt: RtAudioLike | null = null;
  private rate = 0;
  /** 一帧单声道的字节数；写入时再按声道数展开。 */
  private frameBytes = 0;
  private channels = 1;
  private carry = Buffer.alloc(0);
  /** 写进去的音频预计播完的墙钟时刻。 */
  private endsAt = 0;

  constructor(private readonly log: Logger) {}

  /** 正在出声（按写入量估算）。 */
  get playing(): boolean {
    return this.rt !== null && Date.now() < this.endsAt;
  }

  /** 排在已写入的音频后面播放；采样率变了就等前面播完再重开流。 */
  async write(sampleRate: number, raw: Buffer, gain = 1): Promise<void> {
    const pcm = applyGain(raw, gain);
    if (this.rt && sampleRate !== this.rate) {
      await this.drain();
      this.close();
    }
    if (!this.rt) this.open(sampleRate);
    const rt = this.rt!;
    const buf = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const whole = buf.length - (buf.length % this.frameBytes);
    for (let at = 0; at < whole; at += this.frameBytes) rt.write(upmix(buf.subarray(at, at + this.frameBytes), this.channels));
    this.carry = Buffer.from(buf.subarray(whole));
    this.endsAt = Math.max(this.endsAt, Date.now()) + (whole / 2 / sampleRate) * 1000;
  }

  /** 一句写完：把不足一帧的尾巴补静音写出去。 */
  flush(): void {
    if (!this.rt || !this.carry.length) return;
    const frame = Buffer.alloc(this.frameBytes);
    this.carry.copy(frame);
    this.rt.write(upmix(frame, this.channels));
    this.endsAt = Math.max(this.endsAt, Date.now()) + FRAME_MS;
    this.carry = Buffer.alloc(0);
  }

  /** 立刻停下，丢掉没播的部分。 */
  cut(): void {
    this.close();
    this.endsAt = 0;
  }

  close(): void {
    this.carry = Buffer.alloc(0);
    if (!this.rt) return;
    try {
      if (this.rt.isStreamOpen()) this.rt.closeStream();
    } catch (err) {
      this.log.warn('关闭输出流失败', { err: String(err) });
    }
    this.rt = null;
  }

  private drain(): Promise<void> {
    const left = this.endsAt - Date.now();
    return left > 0 ? new Promise((done) => setTimeout(done, left)) : Promise.resolve();
  }

  private open(sampleRate: number): void {
    this.audify ??= loadAudify();
    const audify = this.audify;
    let rt = new audify.RtAudio(apiOf(audify));
    let devices = rt.getDevices().filter((d) => d.outputChannels > 0);
    let deviceId = rt.getDefaultOutputDevice();
    const frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
    const channelsOf = (): number => Math.min(2, Math.max(1, devices.find((d) => d.id === deviceId)?.outputChannels ?? 2));
    const openOn = (): number => {
      rt.openStream(
        { deviceId, nChannels: channelsOf(), firstChannel: 0 },
        null,
        audify.RtAudioFormat.RTAUDIO_SINT16,
        sampleRate,
        frameSize,
        STREAM_NAME,
        null,
        null,
      );
      rt.start();
      return channelsOf();
    };
    let channels: number;
    try {
      channels = openOn();
    } catch (err) {
      // 设备刚切换 / 驱动重排时可能瞬间打不开：换一个新实例再试一次。
      try { if (rt.isStreamOpen()) rt.closeStream(); } catch { /* 已断开 */ }
      rt = new audify.RtAudio(apiOf(audify));
      devices = rt.getDevices().filter((d) => d.outputChannels > 0);
      deviceId = rt.getDefaultOutputDevice();
      try {
        channels = openOn();
      } catch (again) {
        throw new Error(`打不开输出设备：${String(again)}`);
      }
    }
    this.log.debug('本机播放已打开输出流', { sampleRate, channels });
    this.rt = rt;
    this.rate = sampleRate;
    this.frameBytes = frameSize * 2;
    this.channels = channels;
    this.endsAt = 0;
  }
}
