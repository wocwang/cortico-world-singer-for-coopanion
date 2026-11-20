import { describe, expect, it } from 'vitest';
import { MelodyError, meterBeats, parseMelody } from '../src/melody.ts';

describe('parseMelody', () => {
  it('4/4 每小节四个音，各一拍', () => {
    expect(parseMelody('C4 D4 E4 F4')).toEqual([
      { midi: 60, beats: 1 },
      { midi: 62, beats: 1 },
      { midi: 64, beats: 1 },
      { midi: 65, beats: 1 },
    ]);
  });

  it('八分音符槽是半拍，延音并进前一个音', () => {
    const notes = parseMelody('C4 D4 - E4');
    expect(notes.map((note) => note.beats)).toEqual([1, 2, 1]);
    expect(notes[1]!.midi).toBe(62);
  });

  it('休止保留为 null，且不吃歌词', () => {
    expect(parseMelody('C4 . D4 .')).toEqual([
      { midi: 60, beats: 1 },
      { midi: null, beats: 1 },
      { midi: 62, beats: 1 },
      { midi: null, beats: 1 },
    ]);
  });

  it('升降号与八度', () => {
    expect(parseMelody('F#5 Bb3').map((note) => note.midi)).toEqual([78, 58]);
  });

  it('3/4 的一小节是 3 拍', () => {
    expect(parseMelody('C4 D4 E4', '3/4').map((note) => note.beats)).toEqual([1, 1, 1]);
    expect(meterBeats('6/8')).toBe(3);
  });

  it('% 重复上一小节', () => {
    const notes = parseMelody('C4 D4 | %');
    expect(notes.map((note) => note.midi)).toEqual([60, 62, 60, 62]);
  });

  it('[..] 里的几个音平分一个槽（三连音）', () => {
    const notes = parseMelody('[C4 D4 E4] F4 . .');
    expect(notes.map((note) => note.midi)).toEqual([60, 62, 64, 65, null, null]);
    expect(notes[0]!.beats).toBeCloseTo(1 / 3);
    expect(notes[3]!.beats).toBeCloseTo(1);
  });

  it('力度标记不占槽', () => {
    expect(parseMelody('(mf) C4 (p) D4').map((note) => note.midi)).toEqual([60, 62]);
  });

  it('和弦、动机引用、认不出的音都给出可读的报错', () => {
    expect(() => parseMelody('C4+E4')).toThrow(MelodyError);
    expect(() => parseMelody('@hook')).toThrow(/动机引用/);
    expect(() => parseMelody('H4')).toThrow(/认不出/);
    expect(() => parseMelody('- C4')).toThrow(/延音/);
  });

  it('全是休止就不算旋律', () => {
    expect(() => parseMelody('. . .')).toThrow(/没有可唱的音/);
  });
});
