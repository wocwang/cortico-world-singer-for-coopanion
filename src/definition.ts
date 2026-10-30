/** WorldDefinition：装配层按 `cortico.kind === 'world'` 认这个包。 */
import { join } from 'node:path';
import { runtimesRoot } from 'cortico/paths.ts';
import type { Language } from 'cortico/core/language.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import {
  BANK_OPTIONS, COLOR_OPTIONS, DEVICE_OPTIONS, SCALE_OPTIONS, SINGER_DEFAULTS, SINGER_ID, TIER_OPTIONS,
  deviceOptions, scaleOptions, tierOptions,
  type SingerConfigSection,
} from './config.ts';
import { bankInfo, languageLabel, scanBanks } from './banks.ts';
import { SingerWorld } from './world.ts';
import { SINGER_TOOL_DECLS } from './tools.ts';

const DESCRIBE: WorldDescribe = {
  tools: describeTools(SINGER_TOOL_DECLS, {
    singer_sing: {
      zh: '在本机把一句歌词唱出来，紧跟 pet_say 调用，气泡与声音同时开始。',
      en: 'Sings one lyric line on this computer, right before the pet_say that shows the same line, so the bubble appears as the voice begins.',
    },
  }),
  events: [],
};

/**
 * 最近一次 `create` 的配置与数据目录。
 * 配置下拉的选项由框架在打开设置时现问，而 `configOptions(kind, language)` 拿不到配置，
 * 只能从这里读——反正一个部署只有一个 singer 实例。
 */
let live: { cfg: SingerConfigSection; dataDir: string } | null = null;

function bankLibraryDir(): string {
  if (!live) return '';
  return live.cfg.voicebanksDir.trim() || join(live.dataDir, 'voicebanks');
}

/** 当前生效的声库信息：选了库就用库里的那一个，否则看「声库目录」。 */
function activeBank() {
  if (!live) return null;
  const picked = live.cfg.voicebank.trim();
  if (picked) return scanBanks(bankLibraryDir()).find((bank) => bank.name === picked) ?? null;
  const dir = live.cfg.voicebankDir.trim() || join(live.dataDir, 'voicebank');
  return bankInfo(dir);
}

function bankOptions(language: Language): Array<{ value: string; label: string }> {
  const fallback = language === 'zh' ? '默认（声库目录 / 绮萱）' : 'Default (Voicebank folder / Qixuan)';
  const options = [{ value: '', label: fallback }];
  for (const bank of scanBanks(bankLibraryDir())) {
    const langs = languageLabel(bank.languages, language);
    const colors = bank.colors.length ? ` · ${bank.colors.join(' / ')}` : '';
    options.push({ value: bank.name, label: `${bank.label}（${langs}${colors}）` });
  }
  return options;
}

function colorOptions(language: Language): Array<{ value: string; label: string }> {
  const options = [{ value: '', label: language === 'zh' ? '默认（第一个音色）' : 'Default (first colour)' }];
  for (const color of activeBank()?.colors ?? []) options.push({ value: color, label: color });
  return options;
}

export const SINGER: WorldDefinition<SingerConfigSection> = {
  id: SINGER_ID,
  label: 'DiffSinger唱歌',
  defaults: () => structuredClone(SINGER_DEFAULTS),
  configOptions(kind, language) {
    if (kind === TIER_OPTIONS) return tierOptions(language);
    if (kind === DEVICE_OPTIONS) return deviceOptions(language);
    if (kind === SCALE_OPTIONS) return scaleOptions(language);
    if (kind === BANK_OPTIONS) return bankOptions(language);
    if (kind === COLOR_OPTIONS) return colorOptions(language);
    return [];
  },
  // ctx.cfg 是 `worlds.singer` 的活引用：接口开关、参数改了现读即生效
  create: (ctx) => {
    const dataDir = join(ctx.dataDir, 'singer');
    live = { cfg: ctx.cfg, dataDir };
    return new SingerWorld({ cfg: ctx.cfg, dataDir, runtimesRoot });
  },
  describe: DESCRIBE,
};
