import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from 'cortico/core/types.ts';
import { readSingJob, startSingServer, type SingDeps, type SingJob, type SingOutcome, type SingServerHandle } from '../src/server.ts';

const log: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => log,
};

const handles: SingServerHandle[] = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.close(); });

/** 假引擎：记下收到的 job，回一段固定的 wav 头。 */
function fakeDeps(overrides: Partial<SingDeps> = {}): { deps: SingDeps; calls: SingJob[] } {
  const calls: SingJob[] = [];
  const deps: SingDeps = {
    ready: () => true,
    stateText: () => '测试中',
    health: () => ({ ready: true, device: 'cpu', voicebank: 'Qixuan', sampleRate: 44100, speakers: ['qixuan'] }),
    sing: async (job) => {
      calls.push(job);
      const out: SingOutcome = {
        audio: Buffer.from('RIFFfakewav'), sampleRate: 44100, seconds: 1.5,
        notes: 8, sungChars: 8, ms: 42, rvc: false,
        savedPath: job.save ? 'D:/out/sing-1.wav' : undefined,
      };
      return out;
    },
    schema: () => ({ params: { lyrics: { required: true } } }),
    log,
    ...overrides,
  };
  return { deps, calls };
}

async function start(deps: SingDeps, opts: { token?: string; queueLimit?: number } = {}): Promise<string> {
  const handle = await startSingServer({ port: 0, deps, ...opts });
  handles.push(handle);
  return `http://127.0.0.1:${handle.port}`;
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/sing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('参数校验', () => {
  it('歌词必填，其余取默认值', () => {
    const job = readSingJob({ lyrics: '  晚风吹过旧时光  ' });
    expect(job).toMatchObject({
      lyrics: '晚风吹过旧时光', bpm: 96, keyShift: 0, scale: 'major', seed: 0,
      pitchSteps: 10, varianceSteps: 10, acousticSteps: 20, gender: 0,
      maxSeconds: 60, speaker: '', save: false, base64: false,
    });
  });

  it('空歌词、非对象、越界与未知调式都是 400', () => {
    expect(() => readSingJob({ lyrics: '   ' })).toThrow(/lyrics/);
    expect(() => readSingJob([])).toThrow(/JSON 对象/);
    expect(() => readSingJob({ lyrics: '好', bpm: 10 })).toThrow(/bpm/);
    expect(() => readSingJob({ lyrics: '好', keyShift: 20 })).toThrow(/keyShift/);
    expect(() => readSingJob({ lyrics: '好', scale: 'dorian' })).toThrow(/scale/);
    expect(() => readSingJob({ lyrics: '好', acousticSteps: 500 })).toThrow(/acousticSteps/);
    expect(() => readSingJob({ lyrics: '好', gender: 3 })).toThrow(/gender/);
    expect(() => readSingJob({ lyrics: '好'.repeat(2001) })).toThrow(/lyrics/);
  });

  it('布尔字段接受 true/false 与 1/0', () => {
    expect(readSingJob({ lyrics: '好', save: 1, base64: 'true' })).toMatchObject({ save: true, base64: true });
    expect(readSingJob({ lyrics: '好', save: 0, base64: false })).toMatchObject({ save: false, base64: false });
    expect(() => readSingJob({ lyrics: '好', save: 'yes' })).toThrow(/save/);
  });
});

describe('HTTP 接口', () => {
  it('POST /sing 回 wav 与结果响应头', async () => {
    const { deps, calls } = fakeDeps();
    const base = await start(deps);
    const res = await post(base, { lyrics: '晚风吹过旧时光', bpm: 88 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('x-singer-seconds')).toBe('1.5');
    expect(res.headers.get('x-singer-rvc')).toBe('0');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('RIFFfakewav');
    expect(calls[0]).toMatchObject({ lyrics: '晚风吹过旧时光', bpm: 88 });
  });

  it('base64=true 回 JSON 与时间信息', async () => {
    const { deps } = fakeDeps();
    const base = await start(deps);
    const res = await post(base, { lyrics: '好天气', base64: true, save: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, sampleRate: 44100, seconds: 1.5, notes: 8, savedPath: 'D:/out/sing-1.wav' });
    expect(Buffer.from(String(body.audioBase64), 'base64').toString()).toBe('RIFFfakewav');
  });

  it('非法 JSON 与参数错误都是 400', async () => {
    const { deps } = fakeDeps();
    const base = await start(deps);
    expect((await post(base, '{not json')).status).toBe(400);
    const res = await post(base, { lyrics: '好', bpm: 999 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('bpm');
  });

  it('引擎未就绪回 409，令牌不对回 401', async () => {
    const { deps } = fakeDeps({ ready: () => false, stateText: () => '声库还没装' });
    const base = await start(deps, { token: 'secret' });
    expect((await post(base, { lyrics: '好' })).status).toBe(401);
    const res = await post(base, { lyrics: '好' }, { authorization: 'Bearer secret' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('声库还没装');
  });

  it('推理失败回 502，队列满回 503', async () => {
    const { deps } = fakeDeps({
      sing: async () => { throw new Error('onnx 崩了'); },
    });
    const base = await start(deps);
    expect((await post(base, { lyrics: '好' })).status).toBe(502);

    // 前两条挂住，等 gate.fire() 再一起回；之后进来的请求直接回。
    const result: SingOutcome = {
      audio: Buffer.from('x'), sampleRate: 44100, seconds: 1, notes: 1, sungChars: 1, ms: 1, rvc: false,
    };
    let opened = false;
    const waiting: Array<() => void> = [];
    const gate = {
      fire: (): void => {
        opened = true;
        for (const done of waiting.splice(0)) done();
      },
    };
    const slow = fakeDeps({
      sing: () => new Promise<SingOutcome>((resolve) => {
        const done = (): void => resolve(result);
        if (opened) done();
        else waiting.push(done);
      }),
    });
    const base2 = await start(slow.deps, { queueLimit: 2 });
    const first = post(base2, { lyrics: '第一条' });
    await new Promise((r) => setTimeout(r, 50));
    const second = post(base2, { lyrics: '第二条' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await post(base2, { lyrics: '第三条' })).status).toBe(503);
    gate.fire();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it('GET /health 与 GET /sing 自描述', async () => {
    const { deps } = fakeDeps();
    const base = await start(deps);
    const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, ready: true, device: 'cpu', voicebank: 'Qixuan', sampleRate: 44100 });
    const schema = (await (await fetch(`${base}/sing`)).json()) as Record<string, unknown>;
    expect(schema).toMatchObject({ ok: true, ready: true });
    expect(schema.params).toBeTruthy();
    expect(Number((await fetch(`${base}/nope`)).status)).toBe(404);
  });
});
