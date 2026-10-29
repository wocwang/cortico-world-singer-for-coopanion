/**
 * 给其他插件与面板用的本机唱歌接口：`GET /health`、`GET /sing`（自描述参数）、`POST /sing`（JSON 入参）。
 *
 * 只监听 127.0.0.1；配了 token 时要求 `Authorization: Bearer` 或 `?token=`。
 * 单进程串行：并发 1，排队上限默认 4，超出立即 503（调用方按失败处理，不要等）。
 *
 * `POST /sing` 是给外部大模型直接调的形状：纯 JSON 进（没有 multipart、没有文件上传），
 * 默认回 `audio/wav` 字节；`base64: true` 时回 JSON（带 `audioBase64`）。
 * 错误码：400 参数、401 令牌、409 引擎/声库未就绪、502 推理失败、503 队列满。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'cortico/core/types.ts';
import { BPM_MAX, BPM_MIN, KEY_SHIFT_MAX, KEY_SHIFT_MIN } from './config.ts';

/** 请求体上限：只有歌词，1 MB 足够。 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 排队上限（含正在跑的那条）。 */
export const DEFAULT_QUEUE_LIMIT = 4;
/** 歌词长度上限（字符）。 */
export const LYRICS_MAX = 2000;
export const MAX_SECONDS_MIN = 1;
export const MAX_SECONDS_MAX = 300;
export const STEPS_MIN = 1;
export const STEPS_MAX = 100;

export interface SingJob {
  lyrics: string;
  bpm: number;
  keyShift: number;
  scale: 'major' | 'minor';
  seed: number;
  pitchSteps: number;
  varianceSteps: number;
  acousticSteps: number;
  gender: number;
  maxSeconds: number;
  speaker: string;
  /** 另存到插件数据目录，响应带 `x-singer-saved`。 */
  save: boolean;
  /** 回 JSON + base64 而不是音频字节。 */
  base64: boolean;
}

export interface SingOutcome {
  audio: Buffer;
  sampleRate: number;
  seconds: number;
  notes: number;
  sungChars: number;
  /** 整条链路耗时（含可选的 RVC 后处理）。 */
  ms: number;
  /** 这次结果里干声是否又过了 RVC。 */
  rvc: boolean;
  savedPath?: string;
}

export interface SingDeps {
  /** 引擎此刻能不能接活。 */
  ready(): boolean;
  /** 不能接活时的说明，用作 409 文案。 */
  stateText(): string;
  /** 引擎状态：设备、声库、采样率、说话人。 */
  health(): { ready: boolean; device: string | null; voicebank: string | null; sampleRate: number | null; speakers: string[] };
  /** 真正去唱；失败抛 `SingerError`。 */
  sing(job: SingJob): Promise<SingOutcome>;
  /** `GET /sing` 的自描述文档（插件版本、默认参数、示例）。 */
  schema(): Record<string, unknown>;
  log: Logger;
}

export interface SingServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** 带 HTTP 状态码的接口错误，handler 里统一转成 JSON。 */
export class SingerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SingerHttpError';
  }
}

const fail = (field: string, expect: string): never => {
  throw new SingerHttpError(400, `${field} ${expect}`);
};

const readString = (raw: unknown, field: string, max: number, fallback = ''): string => {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') fail(field, '必须是字符串');
  const value = (raw as string).trim();
  if (value.length > max) fail(field, `最长 ${max} 个字符`);
  return value;
};

const readNumber = (raw: unknown, field: string, min: number, max: number, fallback: number, integer = true): number => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) fail(field, '必须是数字');
  if (integer && !Number.isInteger(value)) fail(field, '必须是整数');
  if (value < min || value > max) fail(field, `必须在 ${min}..${max}`);
  return value;
};

const readBool = (raw: unknown, field: string, fallback: boolean): boolean => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  if (raw === 0 || raw === '0' || raw === 'false') return false;
  if (raw === 1 || raw === '1' || raw === 'true') return true;
  return fail(field, '必须是 true/false 或 1/0');
};

/** 请求体校验：字段全部可省略（用默认值），`lyrics` 必填。 */
export function readSingJob(body: unknown): SingJob {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SingerHttpError(400, '请求体必须是 JSON 对象');
  const raw = body as Record<string, unknown>;
  const lyrics = readString(raw.lyrics, 'lyrics', LYRICS_MAX);
  if (!lyrics) throw new SingerHttpError(400, '缺少 lyrics（要唱的歌词）');
  const scale = (readString(raw.scale, 'scale', 16, 'major') || 'major').toLowerCase();
  if (scale !== 'major' && scale !== 'minor') fail('scale', '只能是 major 或 minor');
  return {
    lyrics,
    bpm: readNumber(raw.bpm, 'bpm', BPM_MIN, BPM_MAX, 96),
    keyShift: readNumber(raw.keyShift, 'keyShift', KEY_SHIFT_MIN, KEY_SHIFT_MAX, 0),
    scale: scale as 'major' | 'minor',
    seed: readNumber(raw.seed, 'seed', 0, 2 ** 31 - 1, 0),
    pitchSteps: readNumber(raw.pitchSteps, 'pitchSteps', STEPS_MIN, STEPS_MAX, 10),
    varianceSteps: readNumber(raw.varianceSteps, 'varianceSteps', STEPS_MIN, STEPS_MAX, 10),
    acousticSteps: readNumber(raw.acousticSteps, 'acousticSteps', STEPS_MIN, STEPS_MAX, 20),
    gender: readNumber(raw.gender, 'gender', -1, 1, 0, false),
    maxSeconds: readNumber(raw.maxSeconds, 'maxSeconds', MAX_SECONDS_MIN, MAX_SECONDS_MAX, 60),
    speaker: readString(raw.speaker, 'speaker', 64),
    save: readBool(raw.save, 'save', false),
    base64: readBool(raw.base64, 'base64', false),
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new SingerHttpError(400, `请求体超过 ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** 起接口；`port` 为 0 时由系统分配。 */
export function startSingServer(opts: {
  port: number;
  token?: string;
  deps: SingDeps;
  queueLimit?: number;
}): Promise<SingServerHandle> {
  const { deps } = opts;
  const token = opts.token?.trim() ?? '';
  const limit = opts.queueLimit ?? DEFAULT_QUEUE_LIMIT;

  // 串行队列：并发 1；到上限直接拒绝，不排队等。
  let active = 0;
  const waiting: Array<() => void> = [];
  const depth = (): number => active + waiting.length;
  const acquire = async (): Promise<void> => {
    if (depth() >= limit) throw new SingerHttpError(503, '唱歌队列已满，稍后再试');
    if (active === 0) { active = 1; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active = 0;
  };

  const send = (res: ServerResponse, code: number, body: Buffer | string, type: string, headers: Record<string, string> = {}): void => {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, code: number, obj: unknown): void =>
    send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    if ((req.headers.authorization ?? '') === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
  };

  const sing = async (res: ServerResponse, req: IncomingMessage): Promise<void> => {
    const raw = await readBody(req, MAX_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      throw new SingerHttpError(400, '请求体不是合法 JSON');
    }
    const job = readSingJob(parsed);
    if (!deps.ready()) throw new SingerHttpError(409, `引擎未就绪：${deps.stateText()}`);
    await acquire();
    try {
      const out = await deps.sing(job);
      const headers: Record<string, string> = {
        'x-singer-ms': String(out.ms),
        'x-singer-seconds': String(out.seconds),
        'x-singer-sample-rate': String(out.sampleRate),
        'x-singer-notes': String(out.notes),
        'x-singer-rvc': out.rvc ? '1' : '0',
      };
      if (out.savedPath) headers['x-singer-saved'] = encodeURIComponent(out.savedPath);
      deps.log.info('唱歌完', { bpm: job.bpm, ms: out.ms, seconds: out.seconds, bytes: out.audio.length, rvc: out.rvc });
      if (job.base64) {
        json(res, 200, {
          ok: true,
          sampleRate: out.sampleRate,
          seconds: out.seconds,
          ms: out.ms,
          notes: out.notes,
          sungChars: out.sungChars,
          rvc: out.rvc,
          savedPath: out.savedPath ?? null,
          audioBase64: out.audio.toString('base64'),
        });
        return;
      }
      send(res, 200, out.audio, 'audio/wav', { ...headers, 'content-disposition': 'inline; filename="sing.wav"' });
    } finally {
      release();
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!authorized(req, url)) { json(res, 401, { error: 'bad token' }); return; }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      const health = deps.health();
      json(res, 200, {
        ok: true,
        ready: health.ready,
        device: health.device,
        voicebank: health.voicebank,
        sampleRate: health.sampleRate,
        speakers: health.speakers,
        queue: depth(),
      });
      return;
    }
    // 自描述：外部大模型拿一个 GET 就知道怎么调。
    if (req.method === 'GET' && url.pathname === '/sing') {
      json(res, 200, { ok: true, ...deps.schema(), ready: deps.ready() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sing') {
      void sing(res, req).catch((err: unknown) => {
        if (res.headersSent) { res.destroy(); return; }
        const status = err instanceof SingerHttpError ? err.status : isUnavailable(err) ? 409 : isBadRequest(err) ? 400 : 502;
        const why = err instanceof Error ? err.message : String(err);
        if (status >= 500) deps.log.warn('唱歌接口失败', { status, err: why });
        json(res, status, { error: why });
      });
      return;
    }
    json(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler);
    server.on('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : opts.port;
      deps.log.info('唱歌接口已就绪', { port, auth: !!token, queueLimit: limit });
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

const isBadRequest = (err: unknown): boolean => {
  const kind = err instanceof Error ? (err as { kind?: unknown }).kind : undefined;
  return kind === 'param';
};
const isUnavailable = (err: unknown): boolean => err instanceof Error && (err as { kind?: unknown }).kind === 'unavailable';
