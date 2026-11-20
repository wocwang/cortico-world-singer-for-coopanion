import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { MODEL_BYTES } from '../src/catalog.ts';
import { idleDelayMs, SINGER_DEFAULTS } from '../src/config.ts';
import type { SingerEngine } from '../src/engine.ts';
import { SingerWorld } from '../src/world.ts';

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

/** 起一个 World：不碰网络、不装任何东西；python 路径指向不存在的位置，引擎会立刻报错。 */
async function makeWorld(opts: {
  cfg?: Partial<typeof SINGER_DEFAULTS>;
  createEngine?: () => SingerEngine;
} = {}): Promise<{
  world: SingerWorld;
  dataDir: string;
  invoke: (method: string, args?: unknown[]) => Promise<unknown>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'singer-world-'));
  roots.push(dataDir);
  const world = new SingerWorld({
    cfg: { ...SINGER_DEFAULTS, enabled: true, httpApi: false, ...opts.cfg },
    dataDir,
    runtimesRoot: () => join(dataDir, 'runtimes'),
    ...(opts.createEngine ? { createEngine: () => opts.createEngine!() } : {}),
  });
  worlds.push(world);
  await world.start({ log } as unknown as WorldHost);
  const decl = world.webUi('zh');
  return { world, dataDir, invoke: (method, args = []) => decl.invoke!('service', method, args) };
}

interface State {
  phase: string;
  ready: boolean;
  detail: string | null;
  tier: string;
  port: number | null;
  voicebankDir: string;
  voicebankName: string;
  voicebankReady: boolean;
  vocoderReady: boolean;
  defaultVoicebank: never;
  venv: { phase: string; detail: string | null };
  install: { phase: string; done: number; total: number; detail: string | null };
  defaults: { bpm: number; keyShift: number; scale: string };
  rvc: { enabled: boolean; endpoint: string; voice: string };
  lastSing: unknown;
}

describe('World 面板数据面', () => {
  it('声明两个面板，配置组交给框架', async () => {
    const { world } = await makeWorld();
    const decl = world.webUi('zh');
    expect(decl.panels?.map((p) => p.id)).toEqual(['service', 'sing']);
    expect(decl.config?.map((g) => g.id)).toEqual(['world:singer', 'world:singer:rvc', 'world:singer:service']);
    expect(world.webUi('en').panels?.[0]?.title).toBe('Service');
    expect(world.webUi('zh').lamps?.[0]?.label).toBe('SING');
  });

  it('state 覆盖面板要的字段，声库初始未装', async () => {
    const { invoke, dataDir } = await makeWorld();
    const state = (await invoke('state')) as State;
    expect(state.ready).toBe(false);
    // python 路径不存在：引擎直接报错，不会卡在 starting。
    expect(state.phase).toBe('error');
    expect(state.detail).toContain('Python 解释器不存在');
    expect(state.venv.phase).toBe('absent');
    expect(state.install.phase).toBe('absent');
    expect(state.install.done).toBe(0);
    expect(state.install.total).toBe(MODEL_BYTES);
    expect(state.voicebankDir).toBe(join(dataDir, 'voicebank'));
    expect(state.voicebankName).toBe('voicebank');
    expect(state.voicebankReady).toBe(false);
    expect(state.vocoderReady).toBe(false);
    expect(state.port).toBeNull();
    expect(state.tier).toBe('auto');
    expect(state.defaults).toEqual({ bpm: 96, keyShift: 0, scale: 'major' });
    expect(state.rvc).toEqual({ enabled: false, endpoint: 'http://127.0.0.1:9881', voice: '' });
    expect(state.lastSing).toBeNull();
  });

  it('演唱参数先按接口同一套规则校验', async () => {
    const { invoke } = await makeWorld();
    await expect(invoke('sing', [{}])).rejects.toThrow('缺少 lyrics');
    await expect(invoke('sing', [{}])).rejects.toThrow('缺少 lyrics');
    await expect(invoke('sing', [{ lyrics: '晚风' }])).rejects.toThrow('Python 解释器不存在');
    await expect(invoke('sing', [{ lyrics: '晚风', bpm: 999 }])).rejects.toThrow('bpm 必须在 60..200');
    await expect(invoke('sing', [{ lyrics: '晚风', scale: 'blues' }])).rejects.toThrow('scale 只能是 major 或 minor');
    await expect(invoke('sing', [{ lyrics: '晚风', gender: 3 }])).rejects.toThrow('gender 必须在 -1..1');
    await expect(invoke('sing', [{ lyrics: '晚风', acousticSteps: 0 }])).rejects.toThrow('acousticSteps 必须在 1..100');
    expect(((await invoke('state')) as State).lastSing).toBeNull();
  });

  it('缺少参数或未知方法回 error', async () => {
    const { invoke } = await makeWorld();
    expect(await invoke('nope')).toEqual({ error: 'unknown method: service.nope' });
    expect(await invoke('nope', [])).toEqual({ error: 'unknown method: service.nope' });
  });

  it('环境提示词教模型在 QQ 里点歌，变量带引擎状态', async () => {
    const { world } = await makeWorld();
    const doc = world.webUi('zh').promptDocs?.[0];
    expect(doc?.role).toBe('envPrompt');
    expect(doc?.path.endsWith('env.md')).toBe(true);
    expect(doc?.vars?.map((v) => v.name)).toEqual(['singer.state', 'singer.mouth', 'singer.compose']);
    // 这个 World 的 python 路径不存在，状态里应带上失败原因。
    expect(world.envPromptVars()['singer.state']).toContain('Python 解释器不存在');
  });
});

describe('闲置回收行为', () => {
  /** 只关心生命周期的假引擎：start/stop 翻转 ready，并记停的次数。 */
  function fakeEngine(): { engine: SingerEngine; ready: () => boolean; stops: () => number } {
    let ready = false;
    let stops = 0;
    const engine = {
      start: async () => { ready = true; },
      stop: async () => { ready = false; stops += 1; },
      ready: () => ready,
      state: () => ({ phase: ready ? 'running' : 'stopped', detail: null }),
      queue: () => 0,
    } as unknown as SingerEngine;
    return { engine, ready: () => ready, stops: () => stops };
  }

  it('到 idleMinutes 停引擎，下一条请求自动拉回', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEngine();
      const { world } = await makeWorld({ cfg: { autoStart: true, idleMinutes: 1 }, createEngine: () => fake.engine });
      expect(fake.ready()).toBe(true);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(fake.stops()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.stops()).toBe(1);
      expect(fake.ready()).toBe(false);

      // 服务仍开着：ensureReady 会把它拉回来。
      await world.ensureReady();
      expect(fake.ready()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('idleMinutes 为 0（默认）时永不停引擎', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEngine();
      await makeWorld({ cfg: { autoStart: true }, createEngine: () => fake.engine });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fake.stops()).toBe(0);
      expect(fake.ready()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('小数分钟按秒回收（0.02 = 1.2 秒）', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEngine();
      await makeWorld({ cfg: { autoStart: true, idleMinutes: 0.02 }, createEngine: () => fake.engine });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(fake.stops()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.stops()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('桌宠按需拉起的服务也会排闲置回收', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeEngine();
      const { world } = await makeWorld({
        cfg: { autoStart: false, idleMinutes: 0.02 }, createEngine: () => fake.engine,
      });
      expect(fake.ready()).toBe(false);
      const ready = await world.ensureServiceForTool(1_000);
      expect(ready.ok).toBe(true);
      expect(fake.ready()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(fake.stops()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('闲置回收配置', () => {
  it('默认 0 分钟：升级后引擎照旧常驻', () => {
    expect(SINGER_DEFAULTS.idleMinutes).toBe(0);
  });

  it('服务分组里能改，最小 0（0 表示不回收），支持小数到秒', async () => {
    const { world } = await makeWorld();
    const group = world.webUi('zh').config?.find((g) => g.id.endsWith(':service'));
    const prop = group?.schema.properties?.['worlds.singer.idleMinutes'] as {
      type?: string; minimum?: number; multipleOf?: number;
    } | undefined;
    expect(prop?.type).toBe('number');
    expect(prop?.minimum).toBe(0);
    expect(prop?.multipleOf).toBeUndefined();
    expect(idleDelayMs(0.5)).toBe(30_000);
    expect(idleDelayMs(0.02)).toBe(1_200);
    expect(idleDelayMs(0)).toBe(0);
  });
});

describe('作曲联动开关', () => {
  it('默认关，开关在「唱歌参数」组里，提示词说未开启', async () => {
    expect(SINGER_DEFAULTS.composeLink).toBe(false);
    const { world } = await makeWorld();
    const group = world.webUi('zh').config?.find((g) => g.id === 'world:singer');
    expect(group?.schema.properties?.['worlds.singer.composeLink']).toMatchObject({ type: 'boolean' });
    expect(world.envPromptVars()['singer.compose']).toContain('未开启');
  });
});

describe('唱歌嘴型开关', () => {
  it('默认开启，可在唱歌参数里关掉', async () => {
    expect(SINGER_DEFAULTS.mouthAnimation).toBe(true);
    const { world } = await makeWorld({ cfg: { mouthAnimation: false } });
    const group = world.webUi('zh').config?.find((g) => g.id === 'world:singer');
    expect(group?.schema.properties?.['worlds.singer.mouthAnimation']).toMatchObject({ type: 'boolean' });
    expect(world.envPromptVars()['singer.mouth']).toContain('已关闭');
  });

  it('环境变量按开关给出开启 / 关闭提示', async () => {
    const off = await makeWorld({ cfg: { mouthAnimation: false } });
    expect(off.world.envPromptVars()['singer.mouth']).toContain('不要调用 pet_say');
    const on = await makeWorld();
    expect(on.world.envPromptVars()['singer.mouth']).toContain('气泡会带动嘴型');
  });
});
