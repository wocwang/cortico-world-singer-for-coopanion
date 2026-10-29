/**
 * 真实链路冒烟：用装好的派生 venv + 绮萱声库起 `SingerWorld`（常驻 worker + 本机接口），
 * 等 `/health` 就绪后 POST 一句歌词到 `/sing`，再把面板通道也走一遍，结果写进 `out/`。
 *
 * 本机跑（路径可用环境变量覆盖）：
 *   pnpm exec tsx scripts/smoke.mts
 *   SINGER_SMOKE_PYTHON=... SINGER_SMOKE_BANK=... SINGER_SMOKE_RUNTIME=... SINGER_SMOKE_LYRICS=... pnpm exec tsx scripts/smoke.mts
 *
 * 前置：面板「一键安装」跑完（派生 venv 能 `import diffsinger_utau`，声库目录里有
 * `dsconfig.yaml` 与 `dsvocoder/vocoder.yaml`）。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { SINGER_DEFAULTS } from '../src/config.ts';
import { SingerWorld } from '../src/world.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const here = join(repo, 'out', 'smoke');
const pythonPath = process.env.SINGER_SMOKE_PYTHON || join(tmpdir(), 'singer-probe', 'venv', 'Scripts', 'python.exe');
const voicebankDir = process.env.SINGER_SMOKE_BANK || join(tmpdir(), 'singer-probe', 'voicebank');
const runtimeDir = process.env.SINGER_SMOKE_RUNTIME || '';
const lyrics = process.env.SINGER_SMOKE_LYRICS || '晚风吹过旧时光，我们一起走过那条街';

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? done(addr.port) : fail(new Error('拿不到空闲端口'))));
    });
  });
}

const log: Logger = {
  trace: (m) => console.log(`[trace] ${m}`),
  debug: () => {},
  info: (m, d) => console.log(`[info] ${m}`, d ?? ''),
  warn: (m, d) => console.warn(`[warn] ${m}`, d ?? ''),
  error: (m, d) => console.error(`[error] ${m}`, d ?? ''),
  emit: () => {},
  child: () => log,
};

for (const [name, path] of [['python', pythonPath], ['voicebank', voicebankDir]] as const) {
  if (!existsSync(path)) {
    console.error(`缺少 ${name}：${path}`);
    process.exit(1);
  }
}

const port = await freePort();
const world = new SingerWorld({
  cfg: {
    ...SINGER_DEFAULTS,
    enabled: true,
    tier: 'auto',
    pythonPath,
    runtimeDir,
    voicebankDir,
    httpApi: true,
    httpPort: port,
  },
  dataDir: here,
  runtimesRoot: () => join(here, 'runtimes'),
});

await world.start({ log } as unknown as WorldHost);
const panel = world.webUi('zh').invoke!;

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 600_000;
let health: Record<string, unknown> = {};
while (Date.now() < deadline) {
  try {
    health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
  } catch {
    health = {};
  }
  if (health.ready) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('health:', health);
if (!health.ready) {
  console.error('未就绪：', await panel('service', 'state', []));
  await world.stop();
  process.exit(1);
}

const schema = (await (await fetch(`${base}/sing`)).json()) as Record<string, unknown>;
console.log('schema params:', Object.keys((schema.params ?? {}) as Record<string, unknown>).join(', '));

mkdirSync(here, { recursive: true });

const began = Date.now();
const res = await fetch(`${base}/sing`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ lyrics, bpm: 96, scale: 'major', save: true }),
});
const bytes = Buffer.from(await res.arrayBuffer());
console.log('POST /sing:', res.status, `${Date.now() - began} ms`,
  'x-singer-ms=', res.headers.get('x-singer-ms'),
  'x-singer-seconds=', res.headers.get('x-singer-seconds'),
  'x-singer-saved=', res.headers.get('x-singer-saved'));
const httpOut = join(here, 'http.wav');
writeFileSync(httpOut, bytes);
console.log('written:', httpOut, bytes.length, 'bytes');
if (res.status !== 200 || bytes.subarray(0, 4).toString() !== 'RIFF') {
  console.error('不是 WAV：', bytes.subarray(0, 200).toString('utf8'));
  await world.stop();
  process.exit(1);
}

const panelBin = (await panel('sing', 'sing', [{ lyrics, bpm: 96, scale: 'major' }])) as {
  $binary?: { mime: string; base64: string };
};
const panelBytes = Buffer.from(panelBin.$binary?.base64 ?? '', 'base64');
const panelOut = join(here, 'panel.wav');
writeFileSync(panelOut, panelBytes);
const after = (await panel('service', 'state', [])) as Record<string, unknown>;
console.log('panel sing:', panelBin.$binary?.mime, panelBytes.length, 'bytes', 'last=', after.lastSing);
if (panelBin.$binary?.mime !== 'audio/wav' || panelBytes.subarray(0, 4).toString() !== 'RIFF') {
  console.error('面板结果不对：', { mime: panelBin.$binary?.mime, size: panelBytes.length });
  await world.stop();
  process.exit(1);
}

await world.stop();
console.log('ok', statSync(panelOut).size, 'bytes');
