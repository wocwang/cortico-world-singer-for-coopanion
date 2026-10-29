/**
 * 钉住的上游模型包：每个文件写明字节数、SHA-256 与按顺序尝试的来源。
 *
 * 包体**不带模型**：绮萱声库 401 MB + 社区声码器 50 MB，首次安装时下到插件数据目录，
 * 断点续传、校验通过才落位，然后就地解压（保留完整声库，含使用条款文件），
 * 解压完把 zip 删掉省下 451 MB。
 *
 * 来源顺序：第三方 GitHub 代理（国内直连 release 只有几十 KB/s）→ 官方 release。
 */

/** 绮萱声库（v2.7.0，OpenUTAU 版，ONNX）。 */
export const VOICEBANK_NAME = 'Qixuan_v2.7.0_DiffSinger_OpenUtau';
export const VOICEBANK_VERSION = '2.7.0';

/** 社区声码器（PC-NSF-HiFiGAN 2025.02）。`novel` 名字同时是 dsconfig.yaml 里 `vocoder:` 的取值。 */
export const VOCODER_NAME = 'pc_nsf_hifigan_44.1k_hop512_128bin_2025.02';

export interface PinnedFile {
  /** 落盘文件名；解压后原样保留这个 zip。 */
  path: string;
  bytes: number;
  sha256: string;
  /** 下载地址，按顺序尝试；前一个失败（网络、HTTP 状态、校验）才试下一个。 */
  sources: readonly string[];
}

const QIXUAN_URL =
  'https://github.com/yqzhishen/qixuan-diffsinger/releases/download/v2.7.0/Qixuan_v2.7.0_DiffSinger_OpenUtau.zip';
const VOCODER_URL =
  'https://github.com/openvpi/vocoders/releases/download/pc-nsf-hifigan-44.1k-hop512-128bin-2025.02/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.oudep';

/** GitHub 代理：按实测速度排序（ghfast 最快），最后回官方。 */
const PROXIES: ReadonlyArray<(url: string) => string> = [
  (url) => `https://ghfast.top/${url}`,
  (url) => `https://gh-proxy.com/${url}`,
  (url) => url,
];

const viaProxies = (url: string): string[] => PROXIES.map((wrap) => wrap(url));

export const VOICEBANK_FILE: PinnedFile = {
  path: `${VOICEBANK_NAME}.zip`,
  bytes: 420_707_627,
  sha256: 'fe8ee7c95883d327a2b7facbbe832a7a53e1344918dc791ca83fc23b08034110',
  sources: viaProxies(QIXUAN_URL),
};

/**
 * 声码器包（`.oudep` 就是普通 zip，根目录有 `vocoder.yaml` 与 onnx）解压到声库的 `dsvocoder/`。
 * 声库 zip 若自带 `dsvocoder/`，这个包就不用下（安装流程会先看解压结果）。
 */
export const VOCODER_FILE: PinnedFile = {
  path: `${VOCODER_NAME}.oudep`,
  bytes: 52_760_610,
  sha256: 'ba7d43142d41f6900c8264b5662ca7125a50feb8760bb8b9615c61a8f5e6902e',
  sources: viaProxies(VOCODER_URL),
};

export const MODEL_FILES: readonly PinnedFile[] = [VOICEBANK_FILE, VOCODER_FILE];

/** 解压后判定「装好了」的文件：声库主配置 + 声码器配置。 */
export const VOICEBANK_MARKER = 'dsconfig.yaml';
export const VOCODER_MARKER = 'dsvocoder/vocoder.yaml';

export const MODEL_BYTES = MODEL_FILES.reduce((n, f) => n + f.bytes, 0);

/** 上游页面：安装面板与 README 里给出，用户要核对条款或手动下载时用。 */
export const VOICEBANK_PAGE = 'https://github.com/yqzhishen/qixuan-diffsinger/releases/tag/v2.7.0';
export const VOCODER_PAGE = 'https://openvpi.github.io/vocoders/';
