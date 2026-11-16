/**
 * 钉住的上游模型包：每个文件写明字节数、SHA-256 与按顺序尝试的来源。
 *
 * 包体**不带模型**：绮萱声库 401 MB + 社区声码器 50 MB，首次安装时下到插件数据目录，
 * 断点续传、校验通过才落位，然后就地解压（保留完整声库，含使用条款文件），
 * 解压完把 zip 删掉省下 451 MB。
 *
 * 来源顺序：默认镜像优先、官方兜底，个别对某资产不好使的镜像压到官方之后（绮萱包的 ghfast）；
 * 设了 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 时官方源一律排最前——代理通常已经把 GitHub 打通，
 * 不必再多跳一次镜像。任一来源速度过低会被主动放弃并换下一个（见 install.ts）。
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

/** GitHub 代理；具体某个文件用哪几个、什么顺序，由 viaProxies 的调用方决定。 */
const ghfast = (url: string): string => `https://ghfast.top/${url}`;
const ghProxy = (url: string): string => `https://gh-proxy.com/${url}`;
const ghproxyNet = (url: string): string => `https://ghproxy.net/${url}`;

const hasProxyEnv = (): boolean =>
  ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .some((name) => Boolean(process.env[name]));

/**
 * 拼一个文件的来源顺序：设了代理时官方最前（其余顺序不变），否则镜像在前、官方按 `afterOfficial`
 * 决定插在哪。`afterOfficial` 用来把「已知对该资产不好使」的镜像压到官方之后，避免每次白跑一趟。
 */
const viaProxies = (
  url: string,
  mirrors: ReadonlyArray<(url: string) => string>,
  afterOfficial: ReadonlyArray<(url: string) => string> = [],
): string[] => {
  const head = mirrors.map((wrap) => wrap(url));
  const tail = afterOfficial.map((wrap) => wrap(url));
  return hasProxyEnv() ? [url, ...head, ...tail] : [...head, url, ...tail];
};

// 绮萱这个 401 MB 的包对 ghfast 稳定返回 403：官方排在它前面，ghfast 只作最后兜底。
export const VOICEBANK_FILE: PinnedFile = {
  path: `${VOICEBANK_NAME}.zip`,
  bytes: 420_707_627,
  sha256: 'fe8ee7c95883d327a2b7facbbe832a7a53e1344918dc791ca83fc23b08034110',
  sources: viaProxies(QIXUAN_URL, [ghProxy, ghproxyNet], [ghfast]),
};

/**
 * 声码器包（`.oudep` 就是普通 zip，根目录有 `vocoder.yaml` 与 onnx）解压到声库的 `dsvocoder/`。
 * 声库 zip 若自带 `dsvocoder/`，这个包就不用下（安装流程会先看解压结果）。
 */
export const VOCODER_FILE: PinnedFile = {
  path: `${VOCODER_NAME}.oudep`,
  bytes: 52_760_610,
  sha256: 'ba7d43142d41f6900c8264b5662ca7125a50feb8760bb8b9615c61a8f5e6902e',
  sources: viaProxies(VOCODER_URL, [ghfast, ghProxy]),
};

export const MODEL_FILES: readonly PinnedFile[] = [VOICEBANK_FILE, VOCODER_FILE];

/** 解压后判定「装好了」的文件：声库主配置 + 声码器配置。 */
export const VOICEBANK_MARKER = 'dsconfig.yaml';
export const VOCODER_MARKER = 'dsvocoder/vocoder.yaml';

export const MODEL_BYTES = MODEL_FILES.reduce((n, f) => n + f.bytes, 0);

/** 上游页面：安装面板与 README 里给出，用户要核对条款或手动下载时用。 */
export const VOICEBANK_PAGE = 'https://github.com/yqzhishen/qixuan-diffsinger/releases/tag/v2.7.0';
export const VOCODER_PAGE = 'https://openvpi.github.io/vocoders/';
