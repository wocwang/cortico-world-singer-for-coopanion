import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bankInfo, languageLabel, readLanguages } from '../src/banks.ts';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'singer-banks-'));
  roots.push(dir);
  return dir;
};

/** 造一个声库目录：根目录有 dsconfig.yaml，dsdur 下按需放词典。 */
function makeBank(dicts: Record<string, string>): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'dsconfig.yaml'), 'singer_type: diffsinger\nspeakers:\n- dsmain/embeds/acoustic/acoustic_Normal\n');
  mkdirSync(join(dir, 'dsdur'), { recursive: true });
  for (const [name, text] of Object.entries(dicts)) writeFileSync(join(dir, 'dsdur', name), text);
  return dir;
}

/** 多语言声库那种块状英语词典。 */
const EN_BLOCK = `entries:
${Array.from({ length: 40 }, (_, i) => `- grapheme: 'word${i}'\n  phonemes:\n  - en/k\n  - en/aa\n`).join('')}`;
/** OpenUtau 原生英语声库那种一行流式词典。 */
const EN_FLOW = `entries:
${Array.from({ length: 40 }, (_, i) => `- {grapheme: "word${i}", phonemes: [ow, p, ah, n]}\n`).join('')}`;
/** 单语言日语声库那样的假名词典（`a`/`i`/`cl`，没有 ARPABET 双字母元音）。 */
const JA_PLAIN = `entries:
${Array.from({ length: 40 }, (_, i) => `- grapheme: 'か${i}'\n  phonemes:\n  - k\n  - a\n`).join('')}`;

describe('声库语言识别', () => {
  it('多语言声库有 en/zh 词典 → 中文+英语（大日语词典不认）', () => {
    const dir = makeBank({
      'dsdict-en.yaml': EN_BLOCK,
      'dsdict-zh.yaml': 'entries: []\n',
      'dsdict-ja.yaml': 'entries:\n' + 'X'.repeat(5 * 1024 * 1024),
    });
    expect(readLanguages(dir)).toEqual(['zh', 'en']);
  });

  it('日语声库带小假名词典 → 只报日语', () => {
    const dir = makeBank({ 'dsdict-ja.yaml': JA_PLAIN });
    expect(readLanguages(dir)).toEqual(['ja']);
  });

  it('单一 dsdict.yaml：假名条目认作日语', () => {
    expect(readLanguages(makeBank({ 'dsdict.yaml': JA_PLAIN }))).toEqual(['ja']);
  });

  it('单一 dsdict.yaml：流式 ARPABET 条目认作英语', () => {
    expect(readLanguages(makeBank({ 'dsdict.yaml': EN_FLOW }))).toEqual(['en']);
  });

  it('单一 dsdict.yaml：块状 ARPABET 条目也认作英语', () => {
    expect(readLanguages(makeBank({ 'dsdict.yaml': EN_BLOCK }))).toEqual(['en']);
  });

  it('没有词典时按中文处理', () => {
    expect(readLanguages(makeBank({}))).toEqual(['zh']);
  });

  it('语言标签按 中/日/英 拼接', () => {
    expect(languageLabel(['zh', 'ja', 'en'], 'zh')).toBe('中文+日语+英语');
    expect(languageLabel([], 'en')).toBe('unknown');
    expect(languageLabel([], 'zh')).toBe('未识别');
  });
});

describe('声库信息', () => {
  it('多语言声库能读到音色与语言', () => {
    const dir = makeBank({ 'dsdict-en.yaml': EN_FLOW });
    const info = bankInfo(dir);
    expect(info?.colors).toEqual(['Normal']);
    expect(info?.languages).toEqual(['en']);
  });
});
