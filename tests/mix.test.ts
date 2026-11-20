import { describe, expect, it } from 'vitest';
import { BackingError, mixVocalWithBacking } from '../src/mix.ts';
import { wavFromPcm } from '../src/player.ts';
import { parseWavHeader } from '../src/wav.ts';

const RATE = 44100;

/** 单声道 16-bit wav：整段都是同一个采样值。 */
function mono(value: number, seconds: number, rate = RATE): Buffer {
  const n = Math.max(1, Math.round(seconds * rate));
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(value, i * 2);
  return wavFromPcm(pcm, rate);
}

/** 先静音 `lead` 秒，再整段都是 value。 */
function monoWithLead(value: number, lead: number, seconds: number, rate = RATE): Buffer {
  const n = Math.max(1, Math.round(seconds * rate));
  const pcm = Buffer.alloc(n * 2);
  for (let i = Math.round(lead * rate); i < n; i++) pcm.writeInt16LE(value, i * 2);
  return wavFromPcm(pcm, rate);
}

/** 立体声 16-bit wav：左右两个固定采样值。 */
function stereo(left: number, right: number, seconds: number, rate = RATE): Buffer {
  const n = Math.max(1, Math.round(seconds * rate));
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(left, i * 4);
    pcm.writeInt16LE(right, i * 4 + 2);
  }
  return wavFromPcm(pcm, rate, 2);
}

const sample = (wav: Buffer, index: number): number => {
  const head = parseWavHeader(wav)!;
  return wav.readInt16LE(head.dataStart + index * 2);
};

describe('干声 + 伴奏混合', () => {
  it('输出单声道 16-bit，采样率跟随干声，句尾多留 1.5 秒伴奏', () => {
    const out = mixVocalWithBacking(mono(0, 1), stereo(0, 0, 2));
    const head = parseWavHeader(out.wav)!;
    expect(head.channels).toBe(1);
    expect(head.bitsPerSample).toBe(16);
    expect(head.sampleRate).toBe(RATE);
    expect(out.seconds).toBeCloseTo(2.5, 3);
    expect(head.dataBytes).toBe(Math.round(2.5 * RATE) * 2);
  });

  it('立体声伴奏降混后以固定音量叠在人声下面', () => {
    const out = mixVocalWithBacking(mono(1000, 1), stereo(2000, 2000, 2));
    // 人声 1000 + 伴奏 2000 × 0.5 ≈ 2000；开头不淡出。
    expect(sample(out.wav, 0)).toBeGreaterThanOrEqual(1997);
    expect(sample(out.wav, 0)).toBeLessThanOrEqual(2003);
    // 人声结束后伴奏还在，末尾淡出到 0。
    expect(sample(out.wav, RATE)).toBeGreaterThanOrEqual(997);
    expect(sample(out.wav, Math.round(2.5 * RATE) - 1)).toBe(0);
  });

  it('伴奏比干声短：后面补静音，人声照常唱完', () => {
    const out = mixVocalWithBacking(mono(5000, 1), mono(3000, 0.2));
    expect(out.seconds).toBeCloseTo(2.5, 3);
    // 0.9 秒处伴奏已经结束，只剩人声。
    expect(sample(out.wav, Math.round(0.9 * RATE))).toBe(5000);
  });

  it('裁掉伴奏开头的静音：compose 那 0.3 秒前导不再让歌声提前', () => {
    const out = mixVocalWithBacking(mono(0, 1), monoWithLead(2000, 0.3, 2));
    // 伴奏的第一个音被提到第 0 个采样点，与人声同时开始。
    expect(sample(out.wav, 0)).toBeGreaterThanOrEqual(997);
    expect(sample(out.wav, 0)).toBeLessThanOrEqual(1003);
  });

  it('开头静音最多裁 0.5 秒，曲子本身的前奏休止留着', () => {
    const out = mixVocalWithBacking(mono(0, 1), monoWithLead(2000, 2, 3));
    expect(sample(out.wav, 0)).toBe(0);
    expect(sample(out.wav, Math.round(1.4 * RATE))).toBe(0);
    // 2 秒静音只裁掉 0.5 秒，第一个音在 1.5 秒处。
    expect(sample(out.wav, Math.round(1.5 * RATE))).toBeGreaterThanOrEqual(997);
  });

  it('伴奏采样率不同：重采样后仍从第 0 个采样点对齐', () => {
    const out = mixVocalWithBacking(mono(0, 1), mono(4000, 1, 22050));
    expect(parseWavHeader(out.wav)!.sampleRate).toBe(RATE);
    expect(out.seconds).toBeCloseTo(2.5, 3);
    expect(sample(out.wav, 0)).toBeGreaterThanOrEqual(1997);
    expect(sample(out.wav, 0)).toBeLessThanOrEqual(2003);
  });

  it('不是 WAV / 24-bit / 三声道：报可读的错，不去硬播', () => {
    expect(() => mixVocalWithBacking(mono(0, 0.1), Buffer.from('not a wav'))).toThrow(BackingError);
    const deep = mono(0, 0.1);
    deep.writeUInt16LE(24, 34);
    expect(() => mixVocalWithBacking(mono(0, 0.1), deep)).toThrow(/24-bit/);
    const three = wavFromPcm(Buffer.alloc(3 * 2 * 100), RATE, 3);
    expect(() => mixVocalWithBacking(mono(0, 0.1), three)).toThrow(/3 声道/);
  });
});
