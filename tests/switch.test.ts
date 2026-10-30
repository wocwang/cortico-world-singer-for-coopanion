import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { SINGER_DEFAULTS, type SingerConfigSection } from '../src/config.ts';
import type { EngineState, SingerEngine, SingRequest } from '../src/engine.ts';
import { SingerWorld, resolveVoicebankDir, type EngineInit } from '../src/world.ts';

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
  stops: number;
  state(): EngineState;
}

/** 假引擎：`start` 可以指定失败，`sing` 可以挂住等一个闸门（用来验证「等当前句唱完再切」）。 */
function makeFake(name: string, opts: { failStart?: boolean; gate?: Promise<void> } = {}): Fake {
  const st: EngineState = {
    phase: 'stopped', device: 'cpu', voicebank: name, sampleRate: 44100, speakers: [],
    pid: null, detail: null, startMs: null,
  };
  const fake: Fake & Record<string, unknown> = {
    songs: [],
    stops: 0,
    state: () => ({ ...st, speakers: [...st.speakers] }),
    output: () => [],
    ready: () => st.phase === 'ready',
    queue: () => 0,
    start: async () => {
      if (opts.failStart) {
        st.phase = 'error';
        st.detail = `${name} 载入失败`;
        throw new Error(`${name} 载入失败`);
      }
      st.phase = 'ready';
      st.startMs = 1000;
    },
    stop: async () => {
      st.phase = 'stopped';
      fake.stops += 1;
    },
    sing: async (req: SingRequest) => {
      fake.songs.push(req);
      if (opts.gate) await opts.gate;
      writeFileSync(req.out, Buffer.from('RIFF'));
      return { ms: 5, seconds: 1, notes: 2, sungChars: 2, sampleRate: 44100 };
    },
  };
  return fake;
}

interface State {
  phase: string;
  ready: boolean;
  switching: boolean;
  pendingBank: string | null;
  switchError: string | null;
  voicebankDir: string;
  voicebankName: string;
  bank: { name: string; languages: string[] } | null;
  queue: number;
}

/** 两个声库的临时部署；`makeFakeFor` 决定每个目录拿到哪个假引擎。 */
function makeWorld(makeFakeFor: (dir: string) => Fake) {
  const dataDir = mkdtempSync(join(tmpdir(), 'singer-switch-'));
  roots.push(dataDir);
  const banksDir = join(dataDir, 'voicebanks');
  for (const name of ['bank-a', 'bank-b']) {
    mkdirSync(join(banksDir, name, 'dsdur'), { recursive: true });
    writeFileSync(join(banksDir, name, 'dsconfig.yaml'), 'singer_type: diffsinger\nspeakers:\n- dsmain/embeds/acoustic/acoustic_Normal\n');
  }
  const cfg: SingerConfigSection = {
    ...SINGER_DEFAULTS, enabled: true, httpApi: false, voicebanksDir: banksDir, voicebank: 'bank-a',
  };
  const made: Array<{ dir: string; fake: Fake }> = [];
  const world = new SingerWorld({
    cfg,
    dataDir,
    runtimesRoot: () => join(dataDir, 'runtimes'),
    createEngine: (init: EngineInit) => {
      const fake = makeFakeFor(init.voicebankDir);
      made.push({ dir: init.voicebankDir, fake });
      return fake as unknown as SingerEngine;
    },
  });
  worlds.push(world);
  const start = async (): Promise<((method: string, args?: unknown[]) => Promise<unknown>)> => {
    await world.start({ log } as unknown as WorldHost);
    // bootEngine 是后台起的，等它把假引擎拉到 ready 再开始点唱。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const decl = world.webUi('zh');
    return (method, args = []) => decl.invoke!('service', method, args) as Promise<unknown>;
  };
  return { world, cfg, dataDir, banksDir, made, start };
}

describe('声库热切换', () => {
  it('配置换了声库，下一句用新声库唱的（不用重启）', async () => {
    const { cfg, made, start } = makeWorld((dir) => makeFake(basename(dir)));
    const invoke = await start();
    expect((await invoke('sing', [{ lyrics: '晚风' }])) as { ok?: boolean }).toBeTruthy();
    expect(made.map((m) => basename(m.dir))).toEqual(['bank-a']);
    expect(made[0].fake.songs.length).toBe(1);

    // 设置里换成 bank-b（ctx.cfg 是活引用，改了下句就现读）。
    cfg.voicebank = 'bank-b';
    await invoke('sing', [{ lyrics: '晚风' }]);

    expect(made.map((m) => basename(m.dir))).toEqual(['bank-a', 'bank-b']);
    expect(made[1].fake.songs.length).toBe(1);
    // 旧引擎在新引擎就绪之后才停，中间没有空档。
    expect(made[0].fake.stops).toBe(1);
    const state = (await invoke('state')) as State;
    expect(state.voicebankName).toBe('bank-b');
    expect(state.bank?.name).toBe('bank-b');
    expect(state.switchError).toBeNull();
    expect(state.switching).toBe(false);
  });

  it('新声库载入失败时退回上一个声库，唱歌不挂，原因可读', async () => {
    const { cfg, made, start } = makeWorld((dir) => makeFake(basename(dir), { failStart: basename(dir) === 'bank-b' }));
    const invoke = await start();
    await invoke('sing', [{ lyrics: '晚风' }]);

    cfg.voicebank = 'bank-b';
    // 切失败也不抛：这一句继续用 bank-a 唱出来。
    expect(await invoke('sing', [{ lyrics: '晚风' }])).toHaveProperty('$binary');
    expect(made.map((m) => basename(m.dir))).toEqual(['bank-a', 'bank-b']);
    expect(made[0].fake.songs.length).toBe(2);
    expect(made[1].fake.songs.length).toBe(0);
    expect(made[1].fake.stops).toBe(1); // 失败的新引擎被停掉

    const state = (await invoke('state')) as State;
    expect(state.voicebankName).toBe('bank-a');
    expect(state.switchError).toContain('bank-b');
    expect(state.switchError).toContain('载入失败');

    // 配置没再改：不每句都重试一遍（否则每句都要白等载入时间）。
    await invoke('sing', [{ lyrics: '晚风' }]);
    expect(made.length).toBe(2);
    expect(made[0].fake.songs.length).toBe(3);
  });

  it('换音色不用重建引擎，下一句就带上新音色', async () => {
    const { cfg, made, start } = makeWorld((dir) => makeFake(basename(dir)));
    const invoke = await start();
    await invoke('sing', [{ lyrics: '晚风' }]);

    cfg.voiceColor = 'Soft';
    await invoke('sing', [{ lyrics: '晚风' }]);
    expect(made.length).toBe(1);
    expect(made[0].fake.songs.at(-1)?.speaker).toBe('Soft');
  });

  it('正在唱的那一句不会被打断：换声库排队到它唱完', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { cfg, made, start } = makeWorld((dir) => makeFake(basename(dir), { gate: basename(dir) === 'bank-a' ? gate : undefined }));
    const invoke = await start();

    const first = invoke('sing', [{ lyrics: '第一句' }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    cfg.voicebank = 'bank-b';
    const second = invoke('sing', [{ lyrics: '第二句' }]);

    // 第一句还卡在推理里：这时不该动引擎。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(made.map((m) => basename(m.dir))).toEqual(['bank-a']);
    expect(made[0].fake.stops).toBe(0);

    release();
    await first;
    await second;
    expect(made.map((m) => basename(m.dir))).toEqual(['bank-a', 'bank-b']);
    expect(made[1].fake.songs.length).toBe(1);
    expect(made[1].fake.songs[0].lyrics).toBe('第二句');
  });

  it('把配置改回原声库后不再重复重建引擎', async () => {
    const { cfg, made, start } = makeWorld((dir) => makeFake(basename(dir), { failStart: basename(dir) === 'bank-b' }));
    const invoke = await start();
    await invoke('sing', [{ lyrics: '晚风' }]);
    cfg.voicebank = 'bank-b';
    await invoke('sing', [{ lyrics: '晚风' }]);
    cfg.voicebank = 'bank-a';
    await invoke('sing', [{ lyrics: '晚风' }]);
    expect(made.length).toBe(2);
    expect(made[0].fake.songs.length).toBe(3);
    expect((await invoke('state')) as State).toMatchObject({ voicebankName: 'bank-a' });
  });
});

describe('声库目录解析', () => {
  it('选了总目录里的库就用它，否则用单独的声库目录', () => {
    const dataDir = 'D:\\data';
    expect(resolveVoicebankDir({ voicebank: 'bank-a', voicebankDir: '', voicebanksDir: '' }, dataDir))
      .toBe(join(dataDir, 'voicebanks', 'bank-a'));
    expect(resolveVoicebankDir({ voicebank: 'bank-a', voicebankDir: '', voicebanksDir: 'D:\\models' }, dataDir))
      .toBe(join('D:\\models', 'bank-a'));
    expect(resolveVoicebankDir({ voicebank: '', voicebankDir: 'D:\\bank', voicebanksDir: '' }, dataDir))
      .toBe('D:\\bank');
    expect(resolveVoicebankDir({ voicebank: '', voicebankDir: '', voicebanksDir: '' }, dataDir))
      .toBe(join(dataDir, 'voicebank'));
  });
});
