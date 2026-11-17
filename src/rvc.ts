/**
 * 可选的 RVC 后处理：把绮萱的干声 POST 给 RVC 插件（默认 `127.0.0.1:9881/convert`），
 * 换成小肥鱼 / 星落落大肥鱼的音色。
 *
 * RVC 插件挂载时就会拉起自己的引擎并先开 `/health`，引擎载入要十几到三十秒；
 * 所以先用 `waitForRvc` 探 `/health` 等到 `ready:true` 再送干声，而不是一上来就 POST 吃 409。
 * 等待有明确上限；拉不起来（没装 / 没运行 / 超时）时由调用方退回绮萱原声，并把原因写进回执。
 *
 * 后处理是锦上添花，任何失败都不该让一次演唱失败。
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

/** `/health` 的三种结论：能接活、引擎还在载入、接口根本不通。 */
export type RvcProbe = { state: 'ready' | 'starting' | 'down'; detail: string };

export type RvcConvertResult =
  | { ok: true; audio: Buffer }
  | { ok: false; detail: string };

const DEFAULT_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 1_500;
/** 接口一直不通时，最多再等这么久，给「插件刚挂载、端口还没起来」留一点余量。 */
const APPEAR_MS = 4_000;
const POLL_MS = 800;

const baseOf = (endpoint: string): string => endpoint.trim().replace(/\/+$/, '');

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 探一次 `/health`；连接失败、401、非 JSON 都算 `down`。 */
export async function probeRvc(endpoint: string, opts: { token?: string; timeoutMs?: number } = {}): Promise<RvcProbe> {
  const base = baseOf(endpoint);
  if (!base) return { state: 'down', detail: '接口地址为空' };
  const headers: Record<string, string> = {};
  const token = opts.token?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${base}/health`, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { state: 'down', detail: `health HTTP ${res.status}` };
    const body = (await res.json()) as { ready?: unknown };
    return body.ready === true
      ? { state: 'ready', detail: '' }
      : { state: 'starting', detail: '模型载入中' };
  } catch (err) {
    return { state: 'down', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 等 RVC 真正可转换。接口一直不通只等 `appearMs`（默认 4 秒）就放弃；
 * 接口通但引擎还在载入，则一直等到 `budgetMs`。
 */
export async function waitForRvc(
  endpoint: string,
  opts: { token?: string; budgetMs: number; appearMs?: number; pollMs?: number },
): Promise<{ ok: true } | { ok: false; reason: 'timeout' | 'down'; waitedMs: number; detail: string }> {
  const started = Date.now();
  const budget = Math.max(0, opts.budgetMs);
  const appear = Math.max(0, opts.appearMs ?? APPEAR_MS);
  let starting = false;
  let detail = '';
  for (;;) {
    const probe = await probeRvc(endpoint, { token: opts.token });
    if (probe.state === 'ready') return { ok: true };
    if (probe.state === 'starting') starting = true;
    detail = probe.detail;
    const elapsed = Date.now() - started;
    if (elapsed >= budget) {
      return { ok: false, reason: starting ? 'timeout' : 'down', waitedMs: elapsed, detail };
    }
    if (!starting && elapsed >= appear) {
      return { ok: false, reason: 'down', waitedMs: elapsed, detail };
    }
    await sleep(Math.min(opts.pollMs ?? POLL_MS, Math.max(0, budget - elapsed)));
  }
}

/** 干声 → RVC 音色；失败带原因返回，由调用方决定怎么说明。 */
export async function rvcPost(audio: Buffer, opts: RvcPostOptions): Promise<RvcConvertResult> {
  const base = baseOf(opts.endpoint);
  if (!base) return { ok: false, detail: '接口地址为空' };
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
    if (!res.ok) {
      let reason = '';
      try {
        const info = (await res.json()) as { error?: unknown };
        if (typeof info.error === 'string') reason = `：${info.error}`;
      } catch { /* 非 JSON 错误体，忽略 */ }
      return { ok: false, detail: `HTTP ${res.status}${reason}` };
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('audio/')) return { ok: false, detail: `返回的不是音频（${type || '无 content-type'}）` };
    const out = Buffer.from(await res.arrayBuffer());
    return out.length ? { ok: true, audio: out } : { ok: false, detail: '返回的音频为空' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
