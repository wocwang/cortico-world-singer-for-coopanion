/**
 * 可选的 RVC 后处理：把绮萱的干声 POST 给 RVC 插件（默认 `127.0.0.1:9881/convert`），
 * 换成小肥鱼 / 星落落大肥鱼的音色。
 *
 * 失败一律返回 `null`（RVC 没装、没就绪、超时、返回非音频），调用方退回绮萱原声——
 * 后处理是锦上添花，不该让一次演唱失败。
 */
import { randomUUID } from 'node:crypto';

export interface RvcPostOptions {
  /** 例如 `http://127.0.0.1:9881`。 */
  endpoint: string;
  /** RVC 插件的接口令牌；空为不校验。 */
  token?: string;
  /** `.pth` 名（不含扩展名）；空用 RVC 插件自己的默认音色。 */
  voice?: string;
  /** 变调（半音）。 */
  pitch?: number;
  /** 特征检索率 0..1；不填就按 RVC 接口自己的默认值（0.3）。 */
  indexRate?: number;
  /** 保护率 0..0.5；不填就按 RVC 接口自己的默认值（0.33）。 */
  protect?: number;
  /** 超时；默认 180 秒。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** 干声 → RVC 音色；任何失败都回 `null`。 */
export async function rvcPost(audio: Buffer, opts: RvcPostOptions): Promise<Buffer | null> {
  const base = opts.endpoint.trim().replace(/\/+$/, '');
  if (!base) return null;
  const boundary = `----singer${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  const field = (name: string, value: string): void => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  field('format', 'wav');
  field('save', '0');
  if (opts.voice?.trim()) field('voice', opts.voice.trim());
  field('pitch', String(Math.round(opts.pitch ?? 0)));
  if (typeof opts.indexRate === 'number') field('indexRate', opts.indexRate.toFixed(2));
  if (typeof opts.protect === 'number') field('protect', opts.protect.toFixed(2));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dry.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(audio);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const headers: Record<string, string> = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  const token = opts.token?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${base}/convert`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('audio/')) return null;
    const out = Buffer.from(await res.arrayBuffer());
    return out.length ? out : null;
  } catch {
    return null;
  }
}
