/**
 * 浏览器端面板：`service`（状态 / 一键安装 / 日志尾部）、`sing`（歌词 → 试听 → 下载）。
 * 两个面板的数据都走 `ctx.invoke`，定时拉一次状态。
 *
 * 演唱结果只在浏览器与本地 World 之间走：JSON 参数进 `sing`，回的是 `$binary` wav，
 * 不经 gpt-sovits、也不联网。
 */
import type { WebUiClientBundle, WebUiPanel, WebUi, Disposable } from 'cortico/web/shared/client-panel.ts';
import { panelText } from './text.ts';
import './style.css';

/** 本地版本的 `toDisposable`：浏览器 bundle 只允许 import type 框架，运行时要自带。 */
function disposable(cleanup: () => void): Disposable {
  let done = false;
  return { dispose() { if (!done) { done = true; cleanup(); } } };
}

interface JobState {
  phase: 'absent' | 'working' | 'ready' | 'error';
  done?: number;
  total?: number;
  detail?: string | null;
}
interface SingDone {
  at: number;
  ms: number;
  bytes: number;
  seconds: number;
  notes: number;
  sungChars: number;
  savedPath: string | null;
  bpm: number;
  keyShift: number;
  scale: string;
  rvc: boolean;
}
interface PanelState {
  phase: 'stopped' | 'starting' | 'ready' | 'error';
  ready: boolean;
  /** 推理服务（引擎 + 本机接口）开着没有；面板据此切换「启动服务 / 停止服务」。 */
  service: boolean;
  device: string | null;
  voicebank: string | null;
  sampleRate: number | null;
  speakers: string[];
  startMs: number | null;
  queue: number;
  /** 配置换了声库后，新引擎载入中（`pendingBank` 是目标目录名）。 */
  switching?: boolean;
  pendingBank?: string | null;
  /** 换声库失败的原因；失败时仍在用上一个声库。 */
  switchError?: string | null;
  port: number | null;
  detail: string;
  tail: string[];
  voicebankDir: string;
  voicebankName: string;
  /** 当前生效声库的展示信息：名称 / 语言 / 音色；目录里不是声库时为 null。 */
  bank: { name: string; label: string; languages: string[]; colors: string[] } | null;
  banksDir: string;
  /** 「声库总目录」里扫到的候选声库。 */
  banks: Array<{ name: string; label: string; languages: string[]; colors: string[]; active: boolean }>;
  voiceColor: string;
  voicebankReady: boolean;
  vocoderReady: boolean;
  venv: JobState;
  /** 共享运行时（gpt-sovits CPU 档）的安装状态；没启用自动下载时为 null。 */
  runtime: { phase: 'absent' | 'working' | 'ready' | 'error'; done: number; total: number; detail: string | null } | null;
  runtimeTiers: string[];
  install: JobState;
  defaults: { bpm: number; keyShift: number; scale: string };
  rvc: { enabled: boolean; endpoint: string; voice: string };
  lastSing: SingDone | null;
  /** 已安装模型清单：占多少、能不能卸载。 */
  models?: {
    voicebank: { path: string; bytes: number; ready: boolean };
    venv: { path: string; bytes: number; ready: boolean };
    runtime: { path: string; bytes: number; tier: string | null; shared: boolean };
    tmp: { path: string; bytes: number };
    reclaimable: number;
  };
}

type Tone = 'on' | 'off' | 'warn' | 'bad';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const toneOf = (phase: string): Tone =>
  phase === 'ready' ? 'on' : phase === 'working' || phase === 'starting' ? 'warn' : phase === 'error' ? 'bad' : 'off';

/** 相位 → 通用文案键；未知值按「未安装」显示。 */
type PhaseKey = 'ready' | 'starting' | 'stopped' | 'error' | 'absent' | 'working';
const phaseKey = (phase: string): PhaseKey =>
  phase === 'ready' || phase === 'starting' || phase === 'stopped' || phase === 'error' || phase === 'working' ? phase : 'absent';

/** 状态行：名字 + 标签 + 说明 + 操作。 */
function row(host: HTMLElement, ui: WebUi, name: string): { pill: HTMLSpanElement; detail: HTMLElement; acts: HTMLElement } {
  const line = ui.h('div', 'sn-row');
  const label = ui.h('span', 'sn-name', name);
  const pill = ui.pill('', 'plain');
  const detail = ui.h('span', 'sn-detail');
  const acts = ui.h('span', 'sn-acts');
  line.append(label, pill, detail, acts);
  host.append(line);
  return { pill, detail, acts };
}

function setPill(el: HTMLSpanElement, text: string, tone: Tone): void {
  el.textContent = text;
  el.dataset.tone = tone;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const servicePanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;
    let expanded = false;

    const call = async (method: string, args: unknown[] = []): Promise<void> => {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        const out = await ctx.invoke<PanelState & { error?: string }>(method, args);
        if (out && typeof out === 'object' && 'error' in out && out.error) {
          msg.textContent = out.error;
          msg.classList.add('bad');
          return;
        }
        render(out);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    };

    const sheet = ui.section(t.serviceTitle, t.serviceHint);
    const engineRow = row(sheet, ui, t.rowEngine);
    const depsRow = row(sheet, ui, t.rowDeps);
    const bankRow = row(sheet, ui, t.rowVoicebank);
    // 声库总目录里扫到的候选：每行标出语言与音色，● 是当前生效的那个。
    const banksList = ui.h('div', 'sn-banks');
    sheet.append(ui.h('div', 'sn-detail', t.banksTitle), banksList, ui.h('div', 'sn-detail', t.banksHint));
    const apiRow = row(sheet, ui, t.rowApi);
    const rvcRow = row(sheet, ui, t.rowRvc);

    const bar = ui.progress({ tone: 'warn' });
    bar.el.hidden = true;
    // 已安装模型：每样占多少、能清多少；卸载按钮带二次确认。
    const modelsBox = ui.h('div', 'sn-models');
    sheet.append(
      bar.el,
      ui.h('div', 'sn-detail', t.notice),
      ui.h('div', 'sn-detail', t.modelsTitle),
      modelsBox,
      ui.h('div', 'sn-detail', t.modelsHint),
    );
    let modelsKey = '';

    const installBtn = ui.button(t.install, { variant: 'primary', size: 'sm', onClick: () => void call('install') });
    const cancelBtn = ui.button(t.cancel, { size: 'sm', onClick: () => void call('cancel') });
    const startBtn = ui.button(t.startService, { variant: 'primary', size: 'sm', onClick: () => void call('start') });
    const stopBtn = ui.button(t.stopService, { size: 'sm', onClick: () => void call('stop') });
    const restartBtn = ui.button(t.restart, { size: 'sm', onClick: () => void call('restart') });
    const acts = ui.actions();
    acts.append(installBtn, cancelBtn, startBtn, stopBtn, restartBtn);

    const log = ui.h('pre', 'sn-log');
    log.hidden = true;
    const logToggle = ui.button(t.showLog, {
      size: 'sm',
      onClick: () => {
        expanded = !expanded;
        logToggle.textContent = expanded ? t.hideLog : t.showLog;
        log.hidden = !expanded;
        if (expanded && state) log.textContent = state.tail.join('\n');
      },
    });

    ctx.root.append(sheet, acts, logToggle, log, msg);

    const uninstall = async (target: 'voicebank' | 'venv' | 'tmp', name: string, bytes: number): Promise<void> => {
      if (!(await ui.confirm({ title: t.uninstallConfirm(name, ui.fmt.bytes(bytes)), danger: true }))) return;
      await call('remove', [{ target }]);
    };

    function renderModels(s: PanelState, busy: boolean): void {
      const m = s.models;
      if (!m) { modelsBox.replaceChildren(); return; }
      const lines: HTMLElement[] = [];
      const add = (
        name: string,
        item: { path: string; bytes: number },
        opts: { target?: 'voicebank' | 'venv' | 'tmp'; shared?: boolean },
      ): void => {
        const line = ui.h('div', 'sn-model');
        line.append(ui.h('span', 'sn-model-name', name), ui.h('span', 'sn-model-size', ui.fmt.bytes(item.bytes)));
        if (opts.shared) {
          line.append(ui.h('span', 'sn-model-note', t.modelShared));
        } else if (item.bytes > 0 && opts.target) {
          const target = opts.target;
          const btn = ui.button(t.uninstall, {
            size: 'sm', variant: 'danger', onClick: () => void uninstall(target, name, item.bytes),
          });
          btn.disabled = busy;
          line.append(btn);
        } else {
          line.append(ui.h('span', 'sn-model-note', t.modelEmpty));
        }
        lines.push(line);
      };
      add(t.modelVoicebank, m.voicebank, { target: 'voicebank' });
      add(t.modelVenv, m.venv, { target: 'venv' });
      add(t.modelTmp, m.tmp, { target: 'tmp' });
      if (m.runtime.path) add(t.modelRuntime(m.runtime.tier), m.runtime, { shared: true });
      lines.push(ui.h('div', 'sn-detail', t.reclaimable(ui.fmt.bytes(m.reclaimable))));
      modelsBox.replaceChildren(...lines);
    }

    function render(s: PanelState): void {
      state = s;
      // 引擎
      setPill(
        engineRow.pill,
        !s.service ? t.stopped : s.switching ? t.working : t[phaseKey(s.phase)],
        !s.service ? 'off' : s.switching || s.switchError ? 'warn' : toneOf(s.phase),
      );
      const started = s.phase === 'ready' && s.startMs ? t.startedIn(Math.round(s.startMs / 1000)) : '';
      const switching = s.switching && s.pendingBank ? t.switchingBank(s.pendingBank) : '';
      const switchFailed = !s.switching && s.switchError ? t.bankSwitchFailed(s.switchError) : '';
      engineRow.detail.textContent = !s.service
        ? t.serviceOff
        : [s.ready ? (s.device === 'cuda' ? t.deviceGpu : s.device === 'cpu' ? t.deviceCpu : s.device ?? '') : s.detail, started, switching, switchFailed].filter(Boolean).join(' · ');
      // 依赖（派生 venv）
      setPill(depsRow.pill, t[phaseKey(s.venv.phase)], toneOf(s.venv.phase));
      depsRow.detail.textContent = s.venv.detail
        ?? (s.venv.phase === 'ready'
          ? `${t.depsHint}${s.runtimeTiers.length ? ` · runtime ${s.runtimeTiers.join('/')}` : ''}`
          : [t.depsAbsent, s.runtime && s.runtime.phase !== 'ready' ? t.runtimeHint : ''].filter(Boolean).join(' · '));
      if (s.runtime?.phase === 'working') {
        const pct = s.runtime.total ? ` ${Math.round(s.runtime.done / s.runtime.total * 100)}%` : '';
        depsRow.detail.textContent = `${t.runtimeInstalling}${pct}`;
      }
      // 声库
      const bankDone = s.voicebankReady && s.vocoderReady;
      const busy = s.venv.phase === 'working' || s.install.phase === 'working' || s.runtime?.phase === 'working';
      setPill(
        bankRow.pill,
        s.install.phase === 'working' ? `${t.working} ${s.install.total ? `${Math.round((s.install.done ?? 0) / s.install.total * 100)}%` : ''}` : t[phaseKey(bankDone ? 'ready' : s.install.phase)],
        toneOf(bankDone ? 'ready' : s.install.phase),
      );
      const langText = (codes: string[]): string =>
        codes.map((code) => (code === 'zh' ? t.langZh : code === 'ja' ? t.langJa : code === 'en' ? t.langEn : t.langUnknown)).join('+');
      const meta = s.bank ? t.bankMeta(langText(s.bank.languages), s.bank.colors.join(' / '), s.voiceColor) : '';
      bankRow.detail.textContent = s.install.detail
        ?? (bankDone
          ? [t.bankReady(s.bank?.label ?? s.voicebank ?? s.voicebankName, s.sampleRate), meta].filter(Boolean).join(' · ')
          : `${t.bankAbsent} · ${t.bankHint}`);
      banksList.replaceChildren(...(s.banks.length
        ? s.banks.map((bank) => {
          const line = ui.h('div', 'sn-detail');
          const colors = bank.colors.length ? ` · ${bank.colors.join(' / ')}` : '';
          line.textContent = `${bank.active ? '●' : '○'} ${bank.label} — ${langText(bank.languages)}${colors}`;
          return line;
        })
        : [ui.h('div', 'sn-detail', t.banksEmpty)]));
      bar.el.hidden = s.install.phase !== 'working';
      if (s.install.phase === 'working') bar.setValue(s.install.done ?? 0, s.install.total || 1);
      const allReady = s.venv.phase === 'ready' && bankDone;
      installBtn.textContent = allReady ? t.install : t.installSize(ui.fmt.bytes(s.install.total ?? 0));
      installBtn.disabled = busy || allReady;
      cancelBtn.hidden = !busy;
      // 推理服务：停着只露「启动服务」，开着露「停止服务」与「重启引擎」。
      startBtn.hidden = s.service;
      stopBtn.hidden = !s.service;
      restartBtn.hidden = !s.service;
      startBtn.disabled = busy;
      stopBtn.disabled = busy;
      restartBtn.disabled = busy || s.phase === 'starting';
      // 接口
      setPill(apiRow.pill, s.port ? t.apiOn(s.port) : t.apiOff, s.port ? 'on' : 'off');
      apiRow.detail.textContent = s.queue ? t.queueText(s.queue) : '';
      // RVC 后处理
      setPill(rvcRow.pill, s.rvc.enabled ? t.ready : t.rvcOff, s.rvc.enabled ? 'on' : 'off');
      rvcRow.detail.textContent = s.rvc.enabled ? t.rvcOn(s.rvc.endpoint, s.rvc.voice) : '';
      // 模型清单变化（大小 / 是否装好 / 是否在忙）才重建，别每秒重绘按钮。
      const modelsState = JSON.stringify({ m: s.models ?? null, busy });
      if (modelsState !== modelsKey) { modelsKey = modelsState; renderModels(s, busy); }
      if (expanded) log.textContent = s.tail.join('\n');
    }

    const refresh = async (): Promise<void> => {
      try { render(await ctx.invoke<PanelState>('state')); } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 1000);
  },
};

// ---------------------------------------------------------------------------
// 演唱
// ---------------------------------------------------------------------------

const singPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;
    let url: string | null = null;
    let touched = false;
    ctx.own(disposable(() => { if (url) URL.revokeObjectURL(url); }));

    const sheet = ui.section(t.singTitle, t.singHint);
    const lyrics = ui.textarea({ rows: 3, placeholder: t.lyricsPlaceholder });
    const bpm = ui.input({ type: 'number', value: '96' });
    bpm.min = '60';
    bpm.max = '200';
    bpm.step = '1';
    const keyShift = ui.input({ type: 'number', value: '0' });
    keyShift.min = '-12';
    keyShift.max = '12';
    keyShift.step = '1';
    const scale = ui.select({ value: 'major', options: [{ value: 'major', label: t.scaleMajor }, { value: 'minor', label: t.scaleMinor }] });
    const seed = ui.input({ type: 'number', value: '' });
    seed.min = '0';
    seed.step = '1';
    seed.placeholder = '0';

    const knobs = ui.h('div', 'sn-grid');
    knobs.append(
      ui.field(t.bpmLabel, bpm),
      ui.field(t.keyShiftLabel, keyShift),
      ui.field(t.scaleLabel, scale),
      ui.field(t.seedLabel, seed),
    );

    const singBtn = ui.button(t.sing, { variant: 'primary', size: 'sm', onClick: () => void run() });
    const acts = ui.actions();
    acts.append(singBtn);

    sheet.append(ui.field(t.lyrics, lyrics), knobs, ui.h('div', 'sn-hint', t.seedHint), acts, ui.h('div', 'sn-hint', t.hint));

    const audio = ui.h('audio', 'sn-audio');
    audio.controls = true;
    audio.hidden = true;
    const resultLine = ui.h('div', 'sn-detail');
    const dl = ui.h('a', 'btn sm', t.download);
    dl.hidden = true;

    ctx.root.append(sheet, audio, resultLine, dl, msg);

    /** 首次拿到状态时把配置里的默认值填进表单；用户改过就不再覆盖。 */
    function applyDefaults(s: PanelState): void {
      if (touched) return;
      bpm.value = String(s.defaults.bpm);
      keyShift.value = String(s.defaults.keyShift);
      if (s.defaults.scale === 'major' || s.defaults.scale === 'minor') scale.value = s.defaults.scale;
      touched = !!(lyrics.value || seed.value);
    }

    for (const control of [bpm, keyShift, seed, scale]) {
      control.addEventListener('change', () => { touched = true; });
    }

    async function run(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!lyrics.value.trim()) { msg.textContent = t.emptyLyrics; msg.classList.add('bad'); return; }
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      const busy = ui.busy(t.singTitle, t.singing);
      singBtn.disabled = true;
      try {
        const blob = await ctx.invokeBinary('sing', [{
          lyrics: lyrics.value,
          bpm: Number(bpm.value),
          keyShift: Number(keyShift.value),
          scale: scale.value,
          seed: seed.value === '' ? undefined : Number(seed.value),
        }]);
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        audio.src = url;
        audio.hidden = false;
        dl.href = url;
        dl.download = 'sing.wav';
        dl.hidden = false;
        const done = (await ctx.invoke<PanelState>('state')).lastSing;
        resultLine.textContent = done
          ? [
            t.result(ui.fmt.duration(done.seconds * 1000), ui.fmt.duration(done.ms), done.notes) + (done.rvc ? t.rvcTag : ''),
            done.savedPath ? t.saved(done.savedPath) : '',
          ].filter(Boolean).join(' · ')
          : '';
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      } finally {
        busy.dispose();
        singBtn.disabled = !state?.ready;
      }
    }

    const refresh = async (): Promise<void> => {
      try {
        const s = await ctx.invoke<PanelState>('state');
        applyDefaults(s);
        state = s;
        singBtn.disabled = !s.ready;
        if (!s.ready && !msg.textContent) msg.textContent = s.service ? s.detail : t.serviceOff;
      } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 3000);
  },
};

const bundle: WebUiClientBundle = {
  panels: {
    service: servicePanel,
    sing: singPanel,
  },
};
export default bundle;
