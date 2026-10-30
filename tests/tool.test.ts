import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { SINGER_DEFAULTS, type SingerConfigSection } from '../src/config.ts';
import type { EngineState, SingerEngine, SingRequest } from '../src/engine.ts';
import type { WavPlayer } from '../src/player.ts';
import { SingerWorld, type EngineInit } from '../src/world.ts';

const roots: string[] = [];
const worlds: SingerWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const log: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => log,
};

/** 44.1 kHz 单声道 16-bit 的合法 wav：44 字节头 + 两个采样。 */
function wav(): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(40, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(44100, 24);
  head.writeUInt32LE(88200, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(4, 40);
  return Buffer.concat([head, Buffer.from([0, 1, 0, 2])]);
}

interface Fake {
  songs: SingRequest[];
  starts: number;
  state(): EngineState;
}

/** 假引擎：`start` 幂等，`sing` 写一个合法的假 wav。 */
function makeFake(): Fake {
  const st: EngineState = {
    phase: 'stopped', device: 'cpu', voicebank: 'voicebank', sampleRate: 44100, speakers: [],
    pid: null, detail: null, startMs: null,
  };
  const fake: Fake & Record<string, unknown> = {
    songs: [],
    starts: 0,
    state: () => ({ ...st, speakers: [...st.speakers] }),
    output: () => [],
    ready: () => st.phase === 'ready',
    queue: () => 0,
    start: async () => {
      if (st.phase === 'ready') return;
      fake.starts += 1;
      st.phase = 'ready';
      st.startMs = 1000;
    },
    stop: async () => { st.phase = 'stopped'; },
    sing: async (req: SingRequest) => {
      fake.songs.push(req);
      writeFileSync(req.out, wav());
      return { ms: 5, seconds: 1, notes: 2, sungChars: 2, sampleRate: 44100 };
    },
  };
  return fake;
}

/** 假播放器：记下每次写入的采样率与字节数；`fail` 时 `write` 抛错。 */
class FakePlayer implements WavPlayer {
  writes: Array<{ sampleRate: number; bytes: number }> = [];
  flushes = 0;

  constructor(private readonly fail = false) {}

  async write(sampleRate: number, pcm: Buffer): Promise<void> {
    if (this.fail) throw new Error('打不开输出设备：没有可用设备');
    this.writes.push({ sampleRate, bytes: pcm.length });
  }

  flush(): void { this.flushes += 1; }
  cut(): void {}
  close(): void {}
}

function makeWorld(opts: { failPlayer?: boolean } = {}): {
  fake: Fake;
  player: FakePlayer;
  world: SingerWorld;
  invoke: (method: string, args?: unknown[]) => Promise<unknown>;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'singer-tool-'));
  roots.push(dataDir);
  const voicebankDir = join(dataDir, 'voicebank');
  mkdirSync(join(voicebankDir, 'dsdur'), { recursive: true });
  writeFileSync(join(voicebankDir, 'dsconfig.yaml'), 'singer_type: diffsinger\n');
  const cfg: SingerConfigSection = { ...SINGER_DEFAULTS, enabled: true, httpApi: false, voicebankDir };
  const fake = makeFake();
  const player = new FakePlayer(opts.failPlayer);
  const world = new SingerWorld({
    cfg,
    dataDir,
    runtimesRoot: () => join(dataDir, 'runtimes'),
    createEngine: (_init: EngineInit) => fake as unknown as SingerEngine,
    createPlayer: () => player,
  });
  worlds.push(world);
  const invoke = (method: string, args: unknown[] = []): Promise<unknown> =>
    world.webUi('zh').invoke!('service', method, args);
  return { fake, player, world, invoke };
}

/** bootEngine 是后台起的：等一个宏任务让它把假引擎拉到 ready。 */
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 直接调工具的 handler（Cortico 在真实宿主里就是这么调的）。 */
const call = async (world: SingerWorld, args: Record<string, unknown>): Promise<ToolOutcome> =>
  (await world.tools()[0].handler(args, {} as unknown as ToolCallContext)) as ToolOutcome;

describe('singer_sing 工具', () => {
  it('注册为 speak 工具，lyrics 必填', () => {
    const { world } = makeWorld();
    const [tool] = world.tools();
    expect(tool.name).toBe('singer_sing');
    expect(tool.tags).toEqual(['speak']);
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['lyrics'] });
  });

  it('推理服务停着：不合成、回执提示去点启动服务', async () => {
    const { fake, world, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    await invoke('stop');
    const out = await call(world, { lyrics: '晚风' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('启动服务');
    expect(fake.songs.length).toBe(0);
  });

  it('没给歌词：回失败并写明缺 lyrics', async () => {
    const { world } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, {});
    expect(out.failed).toBe(true);
    expect(out.text).toContain('缺少 lyrics');
  });

  it('正常唱一句：合成一次，data 段写进播放器并 flush', async () => {
    const { fake, player, world } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风吹过旧时光' });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('Sang one line');
    expect(fake.songs.length).toBe(1);
    expect(player.writes).toEqual([{ sampleRate: 44100, bytes: 4 }]);
    expect(player.flushes).toBe(1);
  });

  it('播放失败：回 failed 并写明 could not play，插件不回退成假唱', async () => {
    const { player, world } = makeWorld({ failPlayer: true });
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('could not play');
    expect(player.writes.length).toBe(0);
  });
});
