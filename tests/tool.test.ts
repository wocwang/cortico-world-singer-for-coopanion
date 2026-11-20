import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { SINGER_DEFAULTS, type SingerConfigSection } from '../src/config.ts';
import type { EngineState, SingerEngine, SingRequest } from '../src/engine.ts';
import { wavFromPcm, type WavPlayer } from '../src/player.ts';
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

  async flush(): Promise<void> { this.flushes += 1; }
  cut(): void {}
  close(): void {}
}

function makeWorld(opts: {
  failPlayer?: boolean;
  /** 在部署布局里放一份 cortico-world-compose，模拟装了作曲插件。 */
  compose?: boolean;
  cfg?: Partial<SingerConfigSection>;
} = {}): {
  fake: Fake;
  player: FakePlayer;
  world: SingerWorld;
  dataDir: string;
  invoke: (method: string, args?: unknown[]) => Promise<unknown>;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'singer-tool-'));
  roots.push(dataDir);
  const voicebankDir = join(dataDir, 'voicebank');
  mkdirSync(join(voicebankDir, 'dsdur'), { recursive: true });
  writeFileSync(join(voicebankDir, 'dsconfig.yaml'), 'singer_type: diffsinger\n');
  // 模拟部署布局：runtimes 在 <root>/home/runtimes，扩展在 <root>/extensions/node_modules（没有 RVC 包）。
  mkdirSync(join(dataDir, 'extensions', 'node_modules'), { recursive: true });
  if (opts.compose) {
    const dir = join(dataDir, 'extensions', 'node_modules', 'cortico-world-compose');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"cortico-world-compose"}\n');
  }
  const cfg: SingerConfigSection = {
    ...SINGER_DEFAULTS, enabled: true, httpApi: false, voicebankDir, ...opts.cfg,
  };
  const fake = makeFake();
  const player = new FakePlayer(opts.failPlayer);
  const world = new SingerWorld({
    cfg,
    dataDir,
    runtimesRoot: () => join(dataDir, 'home', 'runtimes'),
    createEngine: (_init: EngineInit) => fake as unknown as SingerEngine,
    createPlayer: () => player,
  });
  worlds.push(world);
  const invoke = (method: string, args: unknown[] = []): Promise<unknown> =>
    world.webUi('zh').invoke!('service', method, args);
  return { fake, player, world, dataDir, invoke };
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

  it('手动停服务：桌宠调用不覆盖，不合成并说明原因', async () => {
    const { fake, world, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    await invoke('stop');
    const out = await call(world, { lyrics: '晚风' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('stopped manually');
    expect(fake.songs.length).toBe(0);
  });

  it('随启动关闭 / 引擎停着：桌宠调用先拉起再唱', async () => {
    const { fake, world } = makeWorld({ cfg: { autoStart: false } });
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    expect(fake.starts).toBe(0);
    const out = await call(world, { lyrics: '晚风' });
    expect(out.failed).toBeUndefined();
    expect(out.text).toBe('晚风');
    expect(fake.starts).toBe(1);
    expect(fake.songs.length).toBe(1);
  });

  it('没给歌词：回失败并写明缺 lyrics', async () => {
    const { world } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, {});
    expect(out.failed).toBe(true);
    expect(out.text).toContain('缺少 lyrics');
  });

  it('正常唱一句：合成一次，data 段写进播放器并 flush，回执正文就是这句歌词', async () => {
    const { fake, player, world } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风吹过旧时光' });
    expect(out.failed).toBeUndefined();
    expect(out.text).toBe('晚风吹过旧时光');
    expect(fake.songs.length).toBe(1);
    expect(player.writes).toEqual([{ sampleRate: 44100, bytes: 4 }]);
    expect(player.flushes).toBe(1);
  });

  it('对话里改速度 / 移调 / 调式：透传给引擎，并沿用到下一句', async () => {
    const { fake, world, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    await call(world, { lyrics: '晚风吹过旧时光', bpm: 72, keyShift: 3, scale: 'minor' });
    await call(world, { lyrics: '再唱一句' });
    expect(fake.songs[0]).toMatchObject({ bpm: 72, keyShift: 3, scale: 'minor' });
    expect(fake.songs[1]).toMatchObject({ bpm: 72, keyShift: 3, scale: 'minor' });
    const st = (await invoke('state')) as { defaults: { bpm: number; keyShift: number; scale: string } };
    expect(st.defaults).toEqual({ bpm: 72, keyShift: 3, scale: 'minor' });
  });

  it('指定旋律：lead-sheet 解析成音符交给引擎；hear 回带录音附件', async () => {
    const { fake, world } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风', melody: 'C4 D4', hear: true });
    expect(out.failed).toBeUndefined();
    expect(fake.songs[0]?.notes).toEqual([
      { midi: 60, beats: 2 },
      { midi: 62, beats: 2 },
    ]);
    expect(out.blobs?.[0]).toMatchObject({ mime: 'audio/wav' });
  });

  it('旋律写错：回失败并说明原因，不去合成', async () => {
    const { fake, world } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风', melody: 'C4+E4' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('单音旋律');
    expect(fake.songs.length).toBe(0);
  });

  it('作曲联动：开着且检测到作曲插件，不带 melody 先拒绝，带了才唱', async () => {
    const { fake, world } = makeWorld({ compose: true, cfg: { composeLink: true } });
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const refused = await call(world, { lyrics: '晚风' });
    expect(refused.failed).toBe(true);
    expect(refused.text).toContain('compose_phrase');
    expect(fake.songs.length).toBe(0);
    const sung = await call(world, { lyrics: '晚风', melody: 'C4 D4' });
    expect(sung.failed).toBeUndefined();
    expect(fake.songs[0]?.notes).toEqual([
      { midi: 60, beats: 2 },
      { midi: 62, beats: 2 },
    ]);
  });

  it('作曲联动：开着但没装作曲插件，仍按原来的方式自动生成旋律', async () => {
    const { fake, world } = makeWorld({ cfg: { composeLink: true } });
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风' });
    expect(out.failed).toBeUndefined();
    expect(fake.songs.length).toBe(1);
    expect(fake.songs[0]?.notes).toBeUndefined();
  });

  it('环境提示词：作曲联动按关 / 开启没装 / 开启且检测到给出三种写法', () => {
    expect(makeWorld().world.envPromptVars()['singer.compose']).toContain('未开启');
    expect(makeWorld({ cfg: { composeLink: true } }).world.envPromptVars()['singer.compose'])
      .toContain('没在这个部署里检测到');
    expect(makeWorld({ compose: true, cfg: { composeLink: true } }).world.envPromptVars()['singer.compose'])
      .toContain('compose_phrase');
  });

  it('伴奏：把 compose 渲染的 wav 混进这一句，同时播放', async () => {
    const { fake, player, world, dataDir } = makeWorld();
    const backing = join(dataDir, 'backing.wav');
    writeFileSync(backing, wavFromPcm(Buffer.alloc(44100 * 4), 44100, 2));
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风', backing, hear: true });
    expect(out.failed).toBeUndefined();
    expect(out.text).toBe('晚风');
    expect(fake.songs.length).toBe(1);
    expect(player.writes.length).toBe(1);
    // 假干声只有 2 个采样；混完至少是干声 + 1.5 秒尾巴。
    expect(player.writes[0]?.bytes).toBeGreaterThan(44100 * 2);
    expect(out.blobs?.[0]).toMatchObject({ mime: 'audio/wav' });
  });

  it('伴奏读不了：清唱并说明原因，不假装有伴奏', async () => {
    const { player, world, dataDir } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风', backing: join(dataDir, 'missing.wav') });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('伴奏没用上');
    expect(player.writes[0]?.bytes).toBe(4);
  });

  it('RVC 不可用：直接播原声，回执写明没装', async () => {
    const { player, world } = makeWorld({ cfg: { rvcEnabled: true, rvcEndpoint: 'http://127.0.0.1:1' } });
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const out = await call(world, { lyrics: '晚风' });
    expect(out.failed).toBeUndefined();
    expect(out.text).toBe('晚风\n（RVC 未安装，本次用绮萱原声）');
    expect(player.writes.length).toBe(1);
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
