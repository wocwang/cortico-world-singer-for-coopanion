/**
 * 把 compose 世界那套 lead-sheet 文本解析成音符。
 *
 * 一句 = 若干小节，用 `|` 分隔；小节里是等长的槽，用空格分隔。槽是音名（`C4`、`F#5`、`Bb4`）、
 * `-`（延音）或 `.`（休止）；`%` 重复上一小节。`[C4 E4 G4]` 表示这几个音平分一个槽（三连音）；
 * `(mf)` 这类力度标记不占槽、直接忽略。只收单音旋律：`+` 和弦、`@` 动机引用一律报错，
 * 让模型先把旋律展开成能直接唱的形态。
 *
 * 时值按拍换算：一个小节 = `meter` 这么多四分音符（4/4 → 4，3/4 → 3，6/8 → 3），
 * 小节里的槽平分这一拍数；`bpm` 决定一拍多少秒。
 */
export class MelodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MelodyError';
  }
}

/** 一个音：`midi` 为 null 是休止；`beats` 以四分音符为单位。 */
export interface MelodyNote {
  midi: number | null;
  beats: number;
}

const NOTE = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/;
const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `4/4` → 4 拍、`3/4` → 3 拍、`6/8` → 3 拍；默认 4/4。 */
export function meterBeats(meter: string): number {
  const text = (meter || '4/4').trim();
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (!match) throw new MelodyError(`meter 要写成 4/4、3/4 这样，收到「${meter}」`);
  const beats = Number(match[1]) * 4 / Number(match[2]);
  if (!(beats >= 1 && beats <= 16)) throw new MelodyError(`meter 超出范围：${meter}`);
  return beats;
}

/** 按空格切槽，`[...]` 里的空格不切。 */
function slotsOf(bar: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of bar) {
    if (ch === '[') { depth += 1; buf += ch; continue; }
    if (ch === ']') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (/\s/.test(ch) && depth === 0) {
      if (buf) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function addSlot(token: string, beats: number, out: MelodyNote[]): void {
  if (token === '-') {
    const last = out[out.length - 1];
    if (!last) throw new MelodyError('旋律以「-」开头：延音前面没有音');
    last.beats += beats;
    return;
  }
  if (token === '.') {
    out.push({ midi: null, beats });
    return;
  }
  if (token.includes('+')) {
    throw new MelodyError('只支持单音旋律：把「+」和弦拆成一条单音线再唱');
  }
  const match = NOTE.exec(token);
  if (!match) {
    throw new MelodyError(`认不出这个音「${token}」：用 C4 / F#5 / Bb4、- 延音、. 休止`);
  }
  const accidental = match[2] === '#' || match[2] === '♯' ? 1 : match[2] === 'b' || match[2] === '♭' ? -1 : 0;
  const midi = (Number(match[3]) + 1) * 12 + SEMITONES[match[1]!.toUpperCase()]! + accidental;
  if (midi < 0 || midi > 127) throw new MelodyError(`音高超出范围：${token}`);
  out.push({ midi, beats });
}

/** 解析一句 lead-sheet；失败抛 `MelodyError`（文案直接给模型看）。 */
export function parseMelody(line: string, meter = '4/4'): MelodyNote[] {
  const text = line.trim();
  if (!text) throw new MelodyError('旋律为空：给我一条 lead-sheet，例如「C4 D4 E4 - | G4 - - .」');
  const barBeats = meterBeats(meter);
  const notes: MelodyNote[] = [];
  let previous: MelodyNote[] | null = null;

  for (const raw of text.split('|')) {
    const bar = raw.trim();
    if (!bar) continue;
    if (bar === '%') {
      if (!previous) throw new MelodyError('「%」前面没有可重复的小节');
      notes.push(...previous.map((note) => ({ ...note })));
      continue;
    }
    const slots = slotsOf(bar);
    if (!slots.length) throw new MelodyError(`小节是空的：${bar}`);
    const start = notes.length;
    const slotBeats = barBeats / slots.length;
    for (const token of slots) {
      if (/^\([^)]*\)$/.test(token)) continue; // 力度标记 (mf) 之类，不占槽
      if (token.startsWith('@')) throw new MelodyError(`「${token}」是 compose 的动机引用，先展开成音符再唱`);
      if (token.startsWith('[')) {
        if (!token.endsWith(']')) throw new MelodyError(`方括号没配对：${token}`);
        const inner = slotsOf(token.slice(1, -1));
        if (!inner.length) throw new MelodyError('空的 [...] 组');
        for (const part of inner) addSlot(part, slotBeats / inner.length, notes);
        continue;
      }
      addSlot(token, slotBeats, notes);
    }
    previous = notes.slice(start).map((note) => ({ ...note }));
  }

  if (!notes.some((note) => note.midi !== null)) throw new MelodyError('旋律里没有可唱的音');
  return notes;
}
