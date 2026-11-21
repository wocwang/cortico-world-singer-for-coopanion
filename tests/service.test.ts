import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { SINGER_DEFAULTS, type SingerConfigSection } from '../src/config.ts';
import type { EngineState, SingerEngine, SingRequest } from '../src/engine.ts';
import type { SingerInstaller } from '../src/install.ts';
import type { RuntimeInstall } from '../src/runtime.ts';
import type { SingerVenv } from '../src/venv.ts';
import { SingerWorld, type EngineInit, type SingerWorldOptions } from '../src/world.ts';

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

interface Fake {
  songs: SingRequest[];
  starts: number;
  stops: number;
  state(): EngineState;
}

/** 假引擎：`start` 幂等（已经 ready 就不再算一次启动），`sing` 写个假 wav。 */
function makeFake(): Fake {
  const st: EngineState = {
    phase: 'stopped', device: 'cpu', voicebank: 'voicebank', sampleRate: 44100, speakers: [],
    pid: null, detail: null, startMs: null,
  };
  const fake: Fake & Record<string, unknown> = {
    songs: [],
    starts: 0,
    stops: 0,
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
    stop: async () => {
      if (st.phase !== 'stopped') fake.stops += 1;
      st.phase = 'stopped';
    },
    sing: async (req: SingRequest) => {
      fake.songs.push(req);
      writeFileSync(req.out, Buffer.from('RIFF'));
      return { ms: 5, seconds: 1, notes: 2, sungChars: 2, sampleRate: 44100 };
    },
  };
  return fake;
}

function makeWorld(
  device?: SingerConfigSection['device'],
  autoStart?: boolean,
  extra: Partial<SingerWorldOptions> = {},
): {
  cfg: SingerConfigSection;
  dataDir: string;
  fake: Fake;
  inits: EngineInit[];
  world: SingerWorld;
  invoke: (method: string, args?: unknown[]) => Promise<unknown>;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'singer-service-'));
  roots.push(dataDir);
  const voicebankDir = join(dataDir, 'voicebank');
  mkdirSync(join(voicebankDir, 'dsdur'), { recursive: true });
  writeFileSync(join(voicebankDir, 'dsconfig.yaml'), 'singer_type: diffsinger\n');
  const cfg: SingerConfigSection = {
    ...SINGER_DEFAULTS, enabled: true, httpApi: false, voicebankDir,
    ...(device ? { device } : {}),
    ...(autoStart === undefined ? {} : { autoStart }),
  };
  const fake = makeFake();
  const inits: EngineInit[] = [];
  const world = new SingerWorld({
    cfg,
    dataDir,
    runtimesRoot: () => join(dataDir, 'runtimes'),
    createEngine: (init: EngineInit) => { inits.push(init); return fake as unknown as SingerEngine; },
    ...extra,
  });
  worlds.push(world);
  const invoke = (method: string, args: unknown[] = []): Promise<unknown> =>
    world.webUi('zh').invoke!('service', method, args);
  return { cfg, dataDir, fake, inits, world, invoke };
}

/** bootEngine 是后台起的：等一个宏任务让它把假引擎拉到 ready。 */
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 假声库安装任务：`install` 一直挂着，等 `finish()` 才结束，用来模拟下载中。 */
class FakeInstaller {
  state: { phase: 'absent' | 'working' | 'ready' | 'error'; done: number; total: number; detail: string | null } =
    { phase: 'absent', done: 0, total: 100, detail: null };
  installs = 0;
  cancels = 0;
  private finishInstall: (() => void) | null = null;

  status(): typeof this.state { return { ...this.state }; }

  install(): Promise<void> {
    this.installs += 1;
    this.state = { phase: 'working', done: 10, total: 100, detail: null };
    return new Promise((resolve) => { this.finishInstall = resolve; });
  }

  cancel(): void { this.cancels += 1; }
  voicebankReady(): boolean { return this.state.phase === 'ready'; }
  vocoderReady(): boolean { return this.state.phase === 'ready'; }

  finish(): void {
    this.state = { phase: 'ready', done: 100, total: 100, detail: null };
    this.finishInstall?.();
    this.finishInstall = null;
  }
}

/** 假派生 venv：check 就绪，ensure 立即成功。 */
class FakeVenv {
  phase: 'absent' | 'working' | 'ready' | 'error' = 'ready';
  state(): { phase: string; detail: null } { return { phase: this.phase, detail: null }; }
  check(): Promise<{ phase: string; detail: null }> { return Promise.resolve(this.state()); }
  ensure(): Promise<void> { this.phase = 'ready'; return Promise.resolve(); }
  cancel(): void {}
}

/** 假共享运行时：第一次 ensure 就装好。 */
class FakeRuntime {
  phase: 'absent' | 'working' | 'ready' | 'error' = 'absent';
  ready(): boolean { return this.phase === 'ready'; }
  status(): { phase: string; done: number; total: number; detail: null } {
    return { phase: this.phase, done: 0, total: 1, detail: null };
  }
  ensure(): Promise<boolean> { this.phase = 'ready'; return Promise.resolve(true); }
  cancel(): void {}
}

interface State {
  phase: string;
  ready: boolean;
  service: boolean;
  port: number | null;
}

describe('推理服务手动启停', () => {
  it('挂载后默认拉起服务', async () => {
    const { world, fake, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    expect(fake.starts).toBe(1);
    expect((await invoke('state')) as State).toMatchObject({ service: true, ready: true, phase: 'ready' });
  });

  it('停止服务：引擎停下、接口关掉、这一句不唱', async () => {
    const { world, fake, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();

    const state = (await invoke('stop')) as State;
    expect(state.service).toBe(false);
    expect(state.phase).toBe('stopped');
    expect(state.ready).toBe(false);
    expect(state.port).toBeNull();
    expect(fake.stops).toBe(1);
    await expect(invoke('sing', [{ lyrics: '晚风' }])).rejects.toThrow('推理服务未启动');
    expect(fake.songs.length).toBe(0);
    // World 还挂载着：环境提示词里的状态变成未启动。
    expect(world.envPromptVars()['singer.state']).toContain('启动服务');
  });

  it('再次启动：同一个引擎重新载入，随后能唱', async () => {
    const { world, fake, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();

    await invoke('stop');
    await invoke('start');
    await nextTick();
    expect(fake.starts).toBe(2);
    expect((await invoke('state')) as State).toMatchObject({ service: true, ready: true });

    await invoke('sing', [{ lyrics: '晚风' }]);
    expect(fake.songs.length).toBe(1);
  });

  it('重复点启动不会重复载入引擎', async () => {
    const { world, fake, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    await invoke('start');
    await nextTick();
    expect(fake.starts).toBe(1);
  });

  it('卸载声库：删掉目录，清单归零', async () => {
    const { cfg, world, fake, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    const before = (await invoke('state')) as State & {
      models: { voicebank: { bytes: number; ready: boolean }; reclaimable: number };
    };
    expect(before.models.voicebank.ready).toBe(true);

    const after = (await invoke('remove', [{ target: 'voicebank' }])) as typeof before;
    expect(after.models.voicebank.bytes).toBe(0);
    expect(after.models.voicebank.ready).toBe(false);
    expect(existsSync(cfg.voicebankDir)).toBe(false);
    // 卸载前先停引擎：假引擎记一次 stop。
    expect(fake.stops).toBe(1);
  });

  it('卸载派生 venv：认 pyvenv.cfg，删完状态归零', async () => {
    const { dataDir, world, invoke } = makeWorld();
    const root = join(dataDir, 'venv');
    mkdirSync(join(root, 'Scripts'), { recursive: true });
    writeFileSync(join(root, 'pyvenv.cfg'), 'home = test\n');
    writeFileSync(join(root, 'Scripts', 'python.exe'), '');
    await world.start({ log } as unknown as WorldHost);
    await nextTick();

    const out = (await invoke('remove', [{ target: 'venv' }])) as { models: { venv: { bytes: number } } };
    expect(out.models.venv.bytes).toBe(0);
    expect(existsSync(root)).toBe(false);
  });

  it('卸载不认识的目录会被拒绝', async () => {
    const { cfg, world, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    // 声库目录里没有 dsconfig.yaml：不删。
    rmSync(join(cfg.voicebankDir, 'dsconfig.yaml'), { force: true });
    const out = (await invoke('remove', [{ target: 'voicebank' }])) as { error?: string };
    expect(out.error).toContain('dsconfig.yaml');
  });

  it('关掉「随 Coopanion 启动」后挂载不拉服务，手动启动仍可用', async () => {
    const { world, fake, invoke } = makeWorld(undefined, false);
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    expect(fake.starts).toBe(0);
    expect((await invoke('state')) as State).toMatchObject({ service: false, phase: 'stopped' });

    await invoke('start');
    await nextTick();
    expect(fake.starts).toBe(1);
    expect((await invoke('state')) as State).toMatchObject({ service: true, ready: true });
  });

  it('推理设备传给引擎：默认 auto，配置 cpu 时照传', async () => {
    const auto = makeWorld();
    await auto.world.start({ log } as unknown as WorldHost);
    expect(auto.inits[0]?.device).toBe('auto');

    const cpu = makeWorld('cpu');
    await cpu.world.start({ log } as unknown as WorldHost);
    expect(cpu.inits[0]?.device).toBe('cpu');
  });

  it('停止服务后重启引擎会顺手把服务启回来', async () => {
    const { world, fake, invoke } = makeWorld();
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    await invoke('stop');

    await invoke('restart');
    await nextTick();
    // 假部署里没有派生 venv：重启只把服务开关拨回来，不会凭空载入引擎（真部署里 venv 就绪才 boot）。
    expect(fake.starts).toBe(1);
    expect((await invoke('state')) as State).toMatchObject({ service: true, phase: 'stopped' });
  });
});

describe('一键安装的实例归属', () => {
  it('换共享运行时后下载跑在当前 installer 上，重入/重启被挡住，取消打到同一个实例', async () => {
    const installers: FakeInstaller[] = [];
    const runtimes: FakeRuntime[] = [];
    const { world, invoke, inits } = makeWorld(undefined, true, {
      createInstaller: () => {
        const fake = new FakeInstaller();
        installers.push(fake);
        return fake as unknown as SingerInstaller;
      },
      createVenv: () => new FakeVenv() as unknown as SingerVenv,
      createRuntime: () => {
        const fake = new FakeRuntime();
        runtimes.push(fake);
        return fake as unknown as RuntimeInstall;
      },
    });
    await world.start({ log } as unknown as WorldHost);
    await nextTick();
    expect(installers.length).toBe(1);

    // 第一次点「一键安装」：运行时装好后 setup() 会换成第 2 代，下载必须落在第 2 代上。
    const kicked = (await invoke('install')) as { installing: boolean };
    expect(kicked.installing).toBe(true);
    await nextTick();
    expect(runtimes[0]?.phase).toBe('ready');
    expect(installers.length).toBe(2);
    const active = installers[1]!;
    expect(active.installs).toBe(1);
    expect((world as unknown as { installer: FakeInstaller }).installer).toBe(active);
    expect((await invoke('state')) as { install: { phase: string }; installing: boolean })
      .toMatchObject({ install: { phase: 'working' }, installing: true });

    // 再点一次不会开第二份下载。
    await invoke('install');
    expect(active.installs).toBe(1);
    expect(installers.length).toBe(2);

    // 安装期间「重启引擎」不重建 setup，界面上的安装按钮也按 installing 禁用。
    const before = inits.length;
    await invoke('restart');
    expect(inits.length).toBe(before);
    expect((world as unknown as { installer: FakeInstaller }).installer).toBe(active);

    // 取消打到正在下载的那个实例。
    await invoke('cancel');
    expect(active.cancels).toBe(1);

    // 装完后面板恢复可操作。
    active.finish();
    await nextTick();
    expect(((await invoke('state')) as { installing: boolean }).installing).toBe(false);
  });

  it('停用插件会取消正在跑的安装', async () => {
    const installers: FakeInstaller[] = [];
    const { world, invoke } = makeWorld(undefined, false, {
      createInstaller: () => {
        const fake = new FakeInstaller();
        installers.push(fake);
        return fake as unknown as SingerInstaller;
      },
      createVenv: () => new FakeVenv() as unknown as SingerVenv,
      createRuntime: () => new FakeRuntime() as unknown as RuntimeInstall,
    });
    await world.start({ log } as unknown as WorldHost);
    await invoke('install');
    await nextTick();
    const active = installers.at(-1)!;
    expect(active.installs).toBe(1);
    await world.stop();
    expect(active.cancels).toBeGreaterThanOrEqual(1);
  });
});
