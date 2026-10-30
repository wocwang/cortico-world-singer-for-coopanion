import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SingerVenv, VENV_PACKAGES, VENV_PACKAGES_GPU } from '../src/venv.ts';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'singer-venv-'));
  roots.push(dir);
  return dir;
};

describe('派生 venv', () => {
  it('只补 diffsinger-utau，不碰运行时的 torch', () => {
    expect(VENV_PACKAGES).toEqual(['diffsinger-utau==0.3.8']);
  });

  it('显卡推理补 onnxruntime-gpu，版本跟探针一致', () => {
    expect(VENV_PACKAGES_GPU).toEqual(['onnxruntime-gpu==1.22.0']);
  });

  it('不需要显卡时不补 onnxruntime-gpu，也不探测它', async () => {
    const dir = tempDir();
    const venv = new SingerVenv({ pythonPath: join(dir, 'venv'), basePython: '' });
    expect((await venv.check()).phase).toBe('absent');
  });

  it('初始是未安装', () => {
    const dir = tempDir();
    const venv = new SingerVenv({
      pythonPath: join(dir, 'venv', 'Scripts', 'python.exe'),
      basePython: join(dir, 'runtime', 'python.exe'),
    });
    expect(venv.state()).toEqual({ phase: 'absent', detail: null });
  });

  it('没有 base 运行时就把原因说清楚，不去跑 pip', async () => {
    const dir = tempDir();
    const venv = new SingerVenv({
      pythonPath: join(dir, 'venv', 'Scripts', 'python.exe'),
      basePython: join(dir, 'runtime', 'python.exe'),
    });
    await venv.ensure();
    const state = venv.state();
    expect(state.phase).toBe('error');
    expect(state.detail).toContain('还没有共享运行时');
  });

  it('取消未开始的任务不会改状态', () => {
    const dir = tempDir();
    const venv = new SingerVenv({ pythonPath: join(dir, 'venv'), basePython: '' });
    venv.cancel();
    expect(venv.state().phase).toBe('absent');
  });

  it('重复 ensure 共用同一个任务', async () => {
    const dir = tempDir();
    const venv = new SingerVenv({
      pythonPath: join(dir, 'venv', 'Scripts', 'python.exe'),
      basePython: '',
    });
    await Promise.all([venv.ensure(), venv.ensure()]);
    expect(venv.state().phase).toBe('error');
  });

  it('探测不到已有 venv 时保持未安装', async () => {
    const dir = tempDir();
    const venv = new SingerVenv({
      pythonPath: join(dir, 'venv', 'Scripts', 'python.exe'),
      basePython: join(dir, 'runtime', 'python.exe'),
    });
    expect((await venv.check()).phase).toBe('absent');
  });
});
