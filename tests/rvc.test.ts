import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { probeRvc, rvcPost, waitForRvc } from '../src/rvc.ts';

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

  it('端口不通算 down，且只等 appear 窗口就放弃', async () => {
    const at = Date.now();
    const out = await waitForRvc('http://127.0.0.1:1', { budgetMs: 5_000, appearMs: 200, pollMs: 50 });
    expect(out).toMatchObject({ ok: false, reason: 'down' });
    expect(Date.now() - at).toBeLessThan(2_000);
  });

  it('一直载入中到达上限后报 timeout', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready: false }));
    });
    const out = await waitForRvc(base, { budgetMs: 400, pollMs: 80 });
    expect(out).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('载入中之后变成就绪：等到 ready 才返回', async () => {
    let ready = false;
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready }));
    });
    setTimeout(() => { ready = true; }, 200);
    const out = await waitForRvc(base, { budgetMs: 3_000, pollMs: 50 });
    expect(out.ok).toBe(true);
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
