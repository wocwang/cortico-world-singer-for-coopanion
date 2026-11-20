/**
 * 把这一句干声和一段伴奏混成一条单声道 PCM16 WAV。
 *
 * 混成一条再交给系统播放器，歌声与伴奏从同一个采样点同时开始，不会因为
 * 两个播放器先后起播而错位；播放器只吃单声道 16-bit，这里顺带做降混与重采样。
 */
import { wavFromPcm } from './player.ts';
import { parseWavHeader } from './wav.ts';

export class BackingError extends Error {}

/** 超过这个大小的伴奏不读：一首歌的 wav 远小于它。 */
export const BACKING_MAX_BYTES = 120 * 1024 * 1024;

/** 句尾多留的伴奏（秒）：唱完不立刻静音，留一点收尾。 */
const TAIL_SECONDS = 1.5;
/** 句尾淡出的长度（秒）；只压伴奏，人声已经结束。 */
const FADE_SECONDS = 0.6;
/** 伴奏相对干声的音量；太响盖住咬字，太小又听不见。 */
const BACKING_GAIN = 0.5;
/** 人声与伴奏相加后的软限幅拐点。 */
const KNEE = 0.85;
/** 伴奏开头最多自动裁掉多少静音（秒）：compose 会在第 1 小节前留 0.3 秒。 */
const LEAD_TRIM_MAX = 0.5;
/** 低于这个幅度算静音（约 −48 dBFS）。 */
const SILENCE = 0.004;

interface Pcm {
  rate: number;
  /** 单声道浮点采样，−1..1。 */
  samples: Float32Array;
}

/** 读 PCM16 wav，混成单声道浮点；别的位深 / 声道数直接报错。 */
function decode(buf: Buffer, what: string): Pcm {
  const head = parseWavHeader(buf);
  if (!head) throw new BackingError(`${what}不是可读的 WAV`);
  if (head.bitsPerSample !== 16) throw new BackingError(`${what}是 ${head.bitsPerSample}-bit，只支持 16-bit PCM`);
  if (head.channels !== 1 && head.channels !== 2) throw new BackingError(`${what}是 ${head.channels} 声道，只支持单声道或立体声`);
  const frame = head.channels * 2;
  const frames = Math.floor(head.dataBytes / frame);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = head.dataStart + i * frame;
    const left = buf.readInt16LE(at) / 32768;
    samples[i] = head.channels === 2 ? (left + buf.readInt16LE(at + 2) / 32768) / 2 : left;
  }
  return { rate: head.sampleRate, samples };
}

/** 线性插值重采样；采样率相同就原样返回。 */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const length = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const at = Math.floor(pos);
    const frac = pos - at;
    const a = input[at] ?? 0;
    const b = input[at + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 超过拐点的部分用 tanh 平滑压回 1 以内，不硬削顶。 */
function softLimit(y: number): number {
  const mag = Math.abs(y);
  if (mag <= KNEE) return y;
  return Math.sign(y) * (KNEE + (1 - KNEE) * Math.tanh((mag - KNEE) / (1 - KNEE)));
}

/**
 * 伴奏开头的数字静音：compose 渲染会在第 1 小节前留 0.3 秒（`LEAD_IN`），
 * 而干声从第 0 个采样点就开唱；不裁掉的话歌声会比伴奏早约 0.3 秒，听起来像对不上。
 * 只裁开头、最多 0.5 秒，避免把曲子本身的前奏休止吃掉。
 */
function leadTrimmed(samples: Float32Array, rate: number): Float32Array {
  const max = Math.min(samples.length, Math.round(LEAD_TRIM_MAX * rate));
  let at = 0;
  while (at < max && Math.abs(samples[at]) < SILENCE) at += 1;
  return at > 0 ? samples.subarray(at) : samples;
}

export interface Mixed {
  wav: Buffer;
  seconds: number;
}

/**
 * 干声 + 伴奏：伴奏降混成单声道并跟到干声的采样率，从第 0 个采样点叠上去；
 * 干声结束后再留一小段伴奏并淡出。伴奏比干声短时补静音，长时截掉。
 */
export function mixVocalWithBacking(vocalWav: Buffer, backingWav: Buffer): Mixed {
  const vocal = decode(vocalWav, '人声');
  const backing = decode(backingWav, '伴奏');
  const rate = vocal.rate;
  const music = resample(leadTrimmed(backing.samples, backing.rate), backing.rate, rate);
  const tail = Math.round(TAIL_SECONDS * rate);
  const length = vocal.samples.length + tail;
  const fade = Math.max(1, Math.round(FADE_SECONDS * rate));
  const pcm = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) {
    const fromEnd = length - 1 - i;
    const fadeGain = fromEnd < fade ? fromEnd / fade : 1;
    const y = softLimit((vocal.samples[i] ?? 0) + (music[i] ?? 0) * BACKING_GAIN * fadeGain);
    pcm.writeInt16LE(Math.round(y * 32767), i * 2);
  }
  return { wav: wavFromPcm(pcm, rate, 1), seconds: length / rate };
}
