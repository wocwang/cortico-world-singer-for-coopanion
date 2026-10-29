/**
 * 声库目录扫描：面板与配置下拉都要「这个声库叫什么、会哪些语言、有几种音色」。
 *
 * 只认 DiffSinger 的目录结构：`dsconfig.yaml` 在目录根，或在唯一一层子目录里
 * （OpenUtau 的 zip 解压后通常多套一层同名文件夹）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface BankInfo {
  /** 目录名，配置里 `voicebank` 存的也是它。 */
  name: string;
  /** `dsconfig.yaml` 所在目录。 */
  dir: string;
  /** 展示名：`character.txt` 的 `name=`，读不到就用目录名。 */
  label: string;
  /** 能唱的语言：`zh` / `ja` / `en`。 */
  languages: string[];
  /** 音色（声学模型的说话人短名），如 `Normal` / `Soft`；单音色声库为空。 */
  colors: string[];
}

const KANA = /[\u3041-\u309f\u30a1-\u30ff]/;
/** 假名词典的上限，与 worker 的 `JA_DICT_MAX_BYTES` 一致。 */
const JA_DICT_MAX_BYTES = 4 * 1024 * 1024;

/** 文本文件按 UTF-8 读，失败按 Shift-JIS 读（日语老声库的元数据是 cp932）。 */
function readText(path: string): string {
  const raw = readFileSync(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(raw);
    } catch {
      return '';
    }
  }
}

/** 找到 `dsconfig.yaml` 所在的那一层；找不到返回空。 */
function bankRoot(dir: string): string {
  if (existsSync(join(dir, 'dsconfig.yaml'))) return dir;
  let subs: string[] = [];
  try {
    subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return '';
  }
  const hits = subs.filter((name) => existsSync(join(dir, name, 'dsconfig.yaml')));
  return hits.length === 1 ? join(dir, hits[0]) : '';
}

/** 从 dsconfig.yaml 的 `speakers:` 段取音色短名（不引 YAML 依赖，逐行看）。 */
export function readColors(root: string): string[] {
  const path = join(root, 'dsconfig.yaml');
  if (!existsSync(path)) return [];
  const lines = readText(path).split(/\r?\n/);
  const start = lines.findIndex((line) => /^speakers:\s*$/.test(line));
  if (start < 0) return [];
  const colors: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const hit = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!hit) break;
    const short = hit[1].split('/').pop() ?? hit[1];
    colors.push(short.startsWith('acoustic_') ? short.slice('acoustic_'.length) : short);
  }
  return colors;
}

/** 语言：只看引擎真能吃下的——中文（拼音表）与日语（声库里的小词名词典）；英语还没接。 */
function readLanguages(root: string): string[] {
  const dsdur = join(root, 'dsdur');
  const langs: string[] = [];
  const jaDict = join(dsdur, 'dsdict-ja.yaml');
  const plain = join(dsdur, 'dsdict.yaml');
  // 多语言声库的 dsdict-ja.yaml 有十几 MB、十几万条，而且不是逐假名的条目，
  // worker 直接不认（解析要一分半）；所以这里也只按「小词典」认日语。
  if (existsSync(jaDict)) {
    if (statSync(jaDict).size <= JA_DICT_MAX_BYTES) langs.push('ja');
    langs.push('zh');
    return langs;
  }
  if (existsSync(join(dsdur, 'dsdict-zh.yaml'))) langs.push('zh');
  if (!langs.length && existsSync(plain)) {
    // 单一 dsdict.yaml：有假名条目、且不大，就是单语言日语声库（如欲音ルコ）。
    const size = statSync(plain).size;
    const text = readText(plain).slice(0, 200_000);
    langs.push(size <= JA_DICT_MAX_BYTES && KANA.test(text) ? 'ja' : 'zh');
  }
  if (!langs.length) langs.push('zh');
  return langs;
}

/** 展示名：`character.txt` 里 `name=`，没有就 `character.yaml` 的 `name`，再没有用目录名。 */
function readLabel(root: string, fallback: string): string {
  const txt = join(root, 'character.txt');
  if (existsSync(txt)) {
    const hit = /^name\s*=\s*(.+)$/m.exec(readText(txt));
    if (hit) return hit[1].trim();
  }
  const yaml = join(root, 'character.yaml');
  if (existsSync(yaml)) {
    const hit = /^name:\s*(.+)$/m.exec(readText(yaml));
    if (hit) return hit[1].trim();
  }
  return fallback;
}

/** 扫一个目录下的声库；目录不存在返回空数组。 */
export function scanBanks(rootDir: string): BankInfo[] {
  if (!rootDir) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const banks: BankInfo[] = [];
  for (const name of entries.sort()) {
    const dir = join(rootDir, name);
    const root = bankRoot(dir);
    if (!root) continue;
    banks.push({
      name,
      dir: root,
      label: readLabel(root, name),
      languages: readLanguages(root),
      colors: readColors(root),
    });
  }
  return banks;
}

/** 单个声库目录的信息（给「声库目录」这种直填路径的场景用）；不是声库返回 null。 */
export function bankInfo(dir: string): BankInfo | null {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const root = bankRoot(dir);
  if (!root) return null;
  return {
    name: basename(dir),
    dir: root,
    label: readLabel(root, basename(dir)),
    languages: readLanguages(root),
    colors: readColors(root),
  };
}

const LANG_TEXT = {
  zh: { zh: '中文', ja: '日语', en: '英语', none: '未识别' },
  en: { zh: 'Chinese', ja: 'Japanese', en: 'English', none: 'unknown' },
};

/** `中/日/英` 这样的语言标签。 */
export function languageLabel(languages: string[], language: string): string {
  const table = language === 'en' ? LANG_TEXT.en : LANG_TEXT.zh;
  const known = languages.filter((code) => code in LANG_TEXT.zh);
  if (!known.length) return table.none;
  return known.map((code) => table[code as 'zh' | 'ja' | 'en']).join('+');
}
