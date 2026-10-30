import { describe, expect, it } from 'vitest';
import { upmix } from '../src/player.ts';
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

describe('upmix', () => {
  it('单声道采样复制成左右两路', () => {
    const mono = Buffer.from([1, 2, 3, 4]);
    const out = upmix(mono, 2);
    expect(out.length).toBe(mono.length * 2);
    expect([...out]).toEqual([1, 2, 1, 2, 3, 4, 3, 4]);
  });

  it('一道路不用展开', () => {
    const mono = Buffer.from([1, 2, 3, 4]);
    expect(upmix(mono, 1)).toBe(mono);
  });
});

describe('parseWavHeader', () => {
  it('读标准 PCM16 单声道头，data 从第 44 字节开始', () => {
    expect(parseWavHeader(wav({ sampleRate: 44100, channels: 1, bits: 16 }))).toEqual({
      sampleRate: 44100,
      channels: 1,
      bitsPerSample: 16,
      dataStart: 44,
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
