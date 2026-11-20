import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { probeRvc, rvcPost, wakeRvc } from '../src/rvc.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  })));
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe('RVC 就绪探测', () => {
  it('health ready=false 时算载入中，ready=true 时算就绪', async () => {
    let ready = false;
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready }));
    });
    expect((await probeRvc(base)).state).toBe('starting');
    ready = true;
    expect((await probeRvc(base)).state).toBe('ready');
  });

  it('接口通但 ready=false（闲置 / 未预热）也算能接活，直接交给 /convert 拉起', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready: false }));
    });
    const at = Date.now();
    const out = await wakeRvc(base, { appearMs: 5_000, pollMs: 50 });
    // 不再像旧逻辑那样等满 budget：能连上就立刻放行。
    expect(out).toEqual({ ok: true, state: 'starting' });
    expect(Date.now() - at).toBeLessThan(1_000);
  });

  it('ready=false 也把干声送过去：引擎启动由 /convert 触发（RVC 懒启动）', async () => {
    let converted = false;
    const base = await serve((req, res) => {
      if (req.url === '/convert') {
        converted = true;
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.from('RIFFfake'));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready: false })); // 永远不 ready，像 RVC 引擎停着时那样
    });
    expect((await wakeRvc(base, { appearMs: 200 })).ok).toBe(true);
    const out = await rvcPost(Buffer.from('dry'), { endpoint: base });
    expect(converted).toBe(true);
    expect(out.ok && out.audio.toString()).toBe('RIFFfake');
  });

  it('端口不通算 down，且只等 appear 窗口就放弃', async () => {
    const at = Date.now();
    const out = await wakeRvc('http://127.0.0.1:1', { appearMs: 200, pollMs: 50 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toBeTruthy();
    expect(Date.now() - at).toBeLessThan(2_000);
  });
});

describe('RVC 转换', () => {
  it('成功时返回音频字节', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(Buffer.from('RIFFfake'));
    });
    const out = await rvcPost(Buffer.from('dry'), { endpoint: base });
    expect(out.ok && out.audio.toString()).toBe('RIFFfake');
  });

  it('409 时返回失败原因而不是抛错', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '模型未就绪：启动中' }));
    });
    const out = await rvcPost(Buffer.from('dry'), { endpoint: base });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain('409');
  });
});
