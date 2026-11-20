/**
 * 只够本机播放用的 WAV 头解析：从 DiffSinger / RVC 拿到的 wav 里找出 PCM 起点与格式。
 * 只认标准 PCM16；别的格式由调用方报失败并写明原因，不硬播。
 */

export interface WavHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** `data` chunk 之后第一个字节在 buf 里的偏移。 */
  dataStart: number;
  /** `data` chunk 声明的字节数（已按实际文件长度截断）。 */
  dataBytes: number;
}

/** 读 wav 头；不是 RIFF/WAVE 或找不到 fmt/data 时回 `null`。 */
export function parseWavHeader(buf: Buffer): WavHeader | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= buf.length) {
      channels = buf.readUInt16LE(at + 10);
      sampleRate = buf.readUInt32LE(at + 12);
      bitsPerSample = buf.readUInt16LE(at + 22);
    }
    if (id === 'data') {
      if (sampleRate <= 0) return null;
      // 有的写作者把 data 长度写成 0 或 0xFFFFFFFF（流式），按实际文件长度收住。
      const available = Math.max(0, buf.length - (at + 8));
      return {
        sampleRate, channels, bitsPerSample, dataStart: at + 8,
        dataBytes: Math.min(size, available),
      };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}
