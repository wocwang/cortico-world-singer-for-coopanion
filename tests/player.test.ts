import { describe, expect, it } from 'vitest';
import { applyGain, wavFromPcm } from '../src/player.ts';
import { parseWavHeader } from '../src/wav.ts';

/** 拼一个标准 PCM wav 头（44 字节），data 段默认 4 字节（两个采样）。 */
function wav(opts: { sampleRate?: number; channels?: number; bits?: number; dataBytes?: number } = {}): Buffer {
  const { sampleRate = 44100, channels = 1, bits = 16, dataBytes = 4 } = opts;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + dataBytes, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  head.writeUInt16LE(channels * (bits / 8), 32);
  head.writeUInt16LE(bits, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([head, Buffer.alloc(dataBytes)]);
}

describe('wavFromPcm', () => {
  it('拼出的 WAV 能被 parseWavHeader 按 44 字节 data 解析', () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const out = wavFromPcm(pcm, 48000);
    expect(out.length).toBe(44 + pcm.length);
    expect(parseWavHeader(out)).toEqual({ sampleRate: 48000, channels: 1, bitsPerSample: 16, dataStart: 44, dataBytes: 4 });
    expect(out.subarray(44)).toEqual(pcm);
  });

  it('RIFF 长度与 data 长度一致', () => {
    const out = wavFromPcm(Buffer.alloc(100), 44100);
    expect(out.readUInt32LE(4)).toBe(36 + 100);
    expect(out.readUInt32LE(40)).toBe(100);
    expect(out.readUInt32LE(28)).toBe(44100 * 2); // byteRate
  });
});

describe('applyGain', () => {
  it('增益为 1 时原样返回', () => {
    const pcm = Buffer.from([1, 2]);
    expect(applyGain(pcm, 1)).toBe(pcm);
  });

  it('超过拐点的样本被压到满幅以内', () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(32000, 0);
    const out = applyGain(pcm, 1.5);
    const v = out.readInt16LE(0);
    expect(v).toBeLessThanOrEqual(32767);
    expect(v).toBeGreaterThan(24000);
  });
});

describe('parseWavHeader', () => {
  it('读标准 PCM16 单声道头，data 从第 44 字节开始', () => {
    expect(parseWavHeader(wav({ sampleRate: 44100, channels: 1, bits: 16 }))).toEqual({
      sampleRate: 44100,
      channels: 1,
      bitsPerSample: 16,
      dataStart: 44,
      dataBytes: 4,
    });
  });

  it('不是 RIFF/WAVE 返回 null', () => {
    expect(parseWavHeader(Buffer.from('not a wav'))).toBeNull();
    expect(parseWavHeader(Buffer.alloc(0))).toBeNull();
  });

  it('双声道 / 8-bit 如实报出来，交给调用方拒绝', () => {
    expect(parseWavHeader(wav({ sampleRate: 48000, channels: 2, bits: 8 }))).toMatchObject({
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 8,
    });
  });
});
