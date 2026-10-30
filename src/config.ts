import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language } from 'cortico/core/language.ts';

export const SINGER_ID = 'singer';

/** 推理档：沿用 gpt-sovits 的口径，`auto` 检测 NVIDIA 显卡后优先 CUDA 档运行时。 */
export type SingerTier = 'auto' | 'cuda' | 'cpu';

/** 推理设备：`auto` 有 NVIDIA 且派生 venv 装好 onnxruntime-gpu 时走显卡，否则 CPU。 */
export type SingerDevice = 'auto' | 'cpu' | 'cuda';

/** 旋律调式：大调 / 小调。小调更忧郁，大调更亮。 */
export type SingerScale = 'major' | 'minor';

/** config.json 的 `worlds.singer` 段。 */
export interface SingerConfigSection {
  enabled: boolean;
  /** 推理档；DiffSinger 走 onnxruntime，改档影响的是派生 venv 基于哪套运行时。 */
  tier: SingerTier;
  /** 推理设备；显卡档要配着「推理档」的 cuda 运行时用（CUDA / cuDNN 在那里）。 */
  device: SingerDevice;
  /** 随 Coopanion 启动就拉起推理服务（引擎 + 本机接口）；关掉后挂载了也先不启动。 */
  autoStart: boolean;
  /**
   * 借用 base 解释器（以及 CUDA / cuDNN）的 gpt-sovits 运行时目录（含 `runtime/python.exe`）。
   * 空为在 `<部署根>/runtimes/gpt-sovits/` 下自动挑一个可用版本。
   */
  runtimeDir: string;
  /**
   * 派生 venv 里的 `python.exe`。空为插件数据目录下的 `venv\Scripts\python.exe`。
   * 派生 venv 以 gpt-sovits 运行时为 base（`--system-site-packages`），只补 diffsinger-utau。
   */
  pythonPath: string;
  /**
   * 声库目录（解压后的绮萱 + `dsvocoder/`）。空为插件数据目录下的 `voicebank`。
   * 模型约 451 MB，首次使用在面板里安装（断点续传、SHA-256 校验），不随包分发。
   */
  voicebankDir: string;
  /** 声库总目录：每个子目录算一个声库，面板与下拉里会标出语言和音色。空为数据目录下的 `voicebanks`。 */
  voicebanksDir: string;
  /** 从「声库总目录」里选中的声库文件夹名；空则用上面的「声库目录」。 */
  voicebank: string;
  /** 音色（声库内的说话人短名，如 `Normal` / `Soft`）；空用第一个。 */
  voiceColor: string;
  /** 默认速度，BPM，60..200。 */
  bpm: number;
  /** 默认移调，半音，−12..12（正数更高）。 */
  keyShift: number;
  /** 默认调式。 */
  scale: SingerScale;
  /** 干声再走一遍 RVC，换成小肥鱼/星落落大肥鱼的音色；默认关。 */
  rvcEnabled: boolean;
  /** RVC 插件接口地址；默认 127.0.0.1:9881（RVC 插件的默认端口）。 */
  rvcEndpoint: string;
  /** RVC 音色（.pth 名，不含扩展名）；空为 RVC 插件的默认音色。 */
  rvcVoice: string;
  /** RVC 特征检索率（0..1）：越高越贴目标音色，但也更容易带进训练集的咬字。 */
  rvcIndexRate: number;
  /** RVC 保护率（0..0.5）：保留原始辅音/气息的比例，高了更像源声、低了更贴目标。 */
  rvcProtect: number;
  /** 对其他插件开放本机 HTTP 接口：只监听 127.0.0.1。 */
  httpApi: boolean;
  /** HTTP 接口端口；默认 9882。 */
  httpPort: number;
  /** HTTP 接口的访问令牌；留空不校验（接口只监听回环地址）。 */
  httpToken: string;
}

export const BPM_MIN = 60;
export const BPM_MAX = 200;
export const KEY_SHIFT_MIN = -12;
export const KEY_SHIFT_MAX = 12;
export const DEFAULT_PORT = 9882;
export const DEFAULT_RVC_ENDPOINT = 'http://127.0.0.1:9881';
/** RVC 接口允许的取值区间；与 RVC 插件那边的校验一致。 */
export const RVC_INDEX_MIN = 0;
export const RVC_INDEX_MAX = 1;
export const RVC_PROTECT_MIN = 0;
export const RVC_PROTECT_MAX = 0.5;

export const SINGER_DEFAULTS: SingerConfigSection = {
  enabled: false,
  tier: 'auto',
  device: 'auto',
  autoStart: true,
  runtimeDir: '',
  pythonPath: '',
  voicebankDir: '',
  voicebanksDir: '',
  voicebank: '',
  voiceColor: '',
  bpm: 96,
  keyShift: 0,
  scale: 'major',
  rvcEnabled: false,
  rvcEndpoint: DEFAULT_RVC_ENDPOINT,
  rvcVoice: '',
  // 与 RVC 接口的缺省值一致：不填这两项时接口按 0.3 / 0.33 处理。
  rvcIndexRate: 0.3,
  rvcProtect: 0.33,
  httpApi: true,
  httpPort: DEFAULT_PORT,
  httpToken: '',
};

const K = `worlds.${SINGER_ID}`;

/** `x-options` 的选项源，由定义的 `configOptions` 给出。 */
export const TIER_OPTIONS = `${SINGER_ID}:tier`;
export const DEVICE_OPTIONS = `${SINGER_ID}:device`;
export const SCALE_OPTIONS = `${SINGER_ID}:scale`;
/** 声库下拉：选项由 `banks.ts` 扫「声库总目录」现算，每项带语言与音色标签。 */
export const BANK_OPTIONS = `${SINGER_ID}:bank`;
/** 音色下拉：选项来自当前选中声库的 `speakers`。 */
export const COLOR_OPTIONS = `${SINGER_ID}:color`;

const TEXT = {
  zh: {
    title: 'DiffSinger 唱歌',
    groupSing: { title: '唱歌参数', description: '默认速度、移调与调式；面板里每次演唱还可以逐次覆盖。' },
    groupRvc: { title: 'RVC 后处理', description: '把绮萱的干声再送进 RVC 换成小肥鱼/星落落大肥鱼的音色。多一趟推理，默认关闭。' },
    groupService: { title: '运行与接口', description: '派生 venv、声库目录，以及给其他插件和外部大模型用的本机 HTTP 接口。' },
    tier: { title: '推理档', description: '自动：检测到 NVIDIA 显卡就借显卡档运行时，否则 CPU 档。它只决定派生 venv 用哪套运行时（CUDA / cuDNN 在显卡档里）；是否真的用显卡推理由下面的「推理设备」决定。改完在面板点「重启引擎」生效，切档会自动重建 venv。' },
    tierAuto: '自动',
    tierCuda: '显卡（NVIDIA）',
    tierCpu: 'CPU',
    device: { title: '推理设备', description: '自动：显卡档运行时、派生 venv 里的 onnxruntime-gpu 与 NVIDIA 显卡都齐了就用显卡，缺一样退回 CPU。显卡推理多占约 0.8 GB 显存，热跑快约 6 倍；首次载入会热身一句，之后每句都不等。切到显卡后第一次「重启引擎」会补装 onnxruntime-gpu（约 215 MB，走阿里云镜像）。' },
    autoStart: { title: '随 Coopanion 启动服务', description: '开着时插件随 Coopanion 一起拉起唱歌引擎与本机接口；关掉后即使插件已加载也先不启动，省内存，要用时在面板「服务」点「启动服务」。这项只在下次启动 Coopanion 时决定初始状态，当前这次随时可以用面板的启动 / 停止。' },
    deviceAuto: '自动',
    deviceCuda: '显卡（NVIDIA）',
    deviceCpu: 'CPU',
    bpm: { title: '默认速度（BPM）', description: '60..200；每字时值按拍折算。' },
    keyShift: { title: '默认移调（半音）', description: '−12..12，正数更高。绮萱是女声，一般 0 到 +4。' },
    scale: { title: '默认调式', description: '大调明亮，小调忧郁；旋律由程序按调式自动生成。' },
    scaleMajor: '大调',
    scaleMinor: '小调',
    rvcEnabled: { title: '启用 RVC 后处理', description: '开着时干声会 POST 给 RVC 插件（默认 127.0.0.1:9881）再返回。RVC 插件没装或没就绪时，本次退回绮萱原声，不报错。' },
    rvcEndpoint: { title: 'RVC 接口地址', description: '默认 http://127.0.0.1:9881；RVC 插件改过端口就跟着改。' },
    rvcVoice: { title: 'RVC 音色', description: '.pth 文件名（不含扩展名），如小肥鱼 / 星落落大肥鱼对应的文件名；留空用 RVC 插件自己的默认音色。' },
    rvcIndexRate: { title: 'RVC 特征检索率', description: '0..1，默认 0.3（与 RVC 接口一致）。调高更贴目标音色，但可能带进训练集的咬字；唱歌通常 0.4–0.6 更明显。' },
    rvcProtect: { title: 'RVC 保护率', description: '0..0.5，默认 0.33。保留原始辅音与气声的比例：高了更像绮萱、低了更贴目标音色。' },
    runtimeDir: { title: 'gpt-sovits 运行时目录', description: '派生 venv 的 base；留空自动挑部署里最新的一个。改完在面板点「重启引擎」生效。' },
    pythonPath: { title: '派生 venv 的 python.exe', description: '留空为插件数据目录下的 venv\\Scripts\\python.exe。改完在面板点「重启引擎」生效。' },
    voicebankDir: { title: '声库目录', description: '解压后的绮萱声库（含 dsvocoder）；留空为插件数据目录下的 voicebank。约 451 MB，首次使用在面板里安装。改完在面板点「重启引擎」生效。' },
    voicebanksDir: { title: '声库总目录', description: '每个子目录算一个声库（里面要有 dsconfig.yaml）。填 D:\\models\\diffsinger-voicebanks 这类存放处，「声库」下拉就能按名字挑；留空为插件数据目录下的 voicebanks。改完在面板点「重启引擎」生效。' },
    voicebank: { title: '声库', description: '从「声库总目录」里挑一个，下拉里标了语言与音色；留空则用上面的「声库目录」。换完下一句就用新声库，不用重启（新声库载入失败会继续用上一个）。' },
    voiceColor: { title: '音色', description: '声库自带的多音色（如 Normal / Soft）；留空用第一个。换完下一句生效，不用重启。' },
    httpApi: { title: '开放本机唱歌接口', description: '给其他插件与外部大模型用：POST /sing 提交歌词与参数，拿回 wav。只监听 127.0.0.1。改完在面板点「重启引擎」生效。' },
    httpPort: { title: '接口端口', description: '默认 9882；与别的程序冲突时换一个。改完在面板点「重启引擎」生效。' },
    httpToken: { title: '接口令牌', description: '留空不校验（只监听本机回环地址）。填了以后请求要带 Authorization: Bearer 或 ?token=。改完在面板点「重启引擎」生效。' },
  },
  en: {
    title: 'DiffSinger Singing',
    groupSing: { title: 'Singing', description: 'Default tempo, transpose and scale; the panel can override them per performance.' },
    groupRvc: { title: 'RVC post-processing', description: 'Send the dry Qixuan vocal through RVC to get the DaFeiyu timbre. One extra inference pass; off by default.' },
    groupService: { title: 'Runtime and API', description: 'Derived venv, voicebank folder, and the loopback HTTP endpoint for other plugins and online LLMs.' },
    tier: { title: 'Inference tier', description: 'Auto borrows the GPU runtime when an NVIDIA GPU is detected, otherwise CPU. It only picks which runtime the derived venv is based on (CUDA / cuDNN live in the GPU tier); whether inference itself runs on the GPU is decided by Inference device below. After changing this, click Restart engine — switching tiers rebuilds the venv automatically.' },
    tierAuto: 'Auto',
    tierCuda: 'GPU (NVIDIA)',
    tierCpu: 'CPU',
    device: { title: 'Inference device', description: 'Auto uses the GPU when the GPU runtime, onnxruntime-gpu in the derived venv and an NVIDIA GPU are all present; otherwise CPU. GPU inference takes about 0.8 GB of VRAM and is roughly 6x faster once warm; the engine sings a short warm-up line after loading, so the first real line never waits. Switching to GPU makes the next Restart engine install onnxruntime-gpu (~215 MB, Aliyun mirror first).' },
    autoStart: { title: 'Start the service with Coopanion', description: 'On means the plugin brings the singing engine and the loopback API up together with Coopanion. Off keeps the service stopped even though the plugin is loaded, saving memory; click Start service in the Service panel when you need it. This only decides the initial state on the next Coopanion launch; the Start / Stop buttons still work any time.' },
    deviceAuto: 'Auto',
    deviceCuda: 'GPU (NVIDIA)',
    deviceCpu: 'CPU',
    bpm: { title: 'Default tempo (BPM)', description: '60..200; note lengths are derived from the beat.' },
    keyShift: { title: 'Default transpose (semitones)', description: '−12..12, positive is higher. Qixuan is a female voice, usually 0 to +4.' },
    scale: { title: 'Default scale', description: 'Major is bright, minor is moody; the melody is generated in that scale.' },
    scaleMajor: 'Major',
    scaleMinor: 'Minor',
    rvcEnabled: { title: 'Enable RVC post-processing', description: 'When on, the dry vocal is POSTed to the RVC plugin (127.0.0.1:9881 by default). If RVC is missing or not ready, this run falls back to the raw Qixuan voice instead of failing.' },
    rvcEndpoint: { title: 'RVC endpoint', description: 'Defaults to http://127.0.0.1:9881; change it if the RVC plugin uses another port.' },
    rvcVoice: { title: 'RVC voice', description: 'A .pth file name without the extension (e.g. the file behind 小肥鱼 / 星落落大肥鱼); empty uses the RVC plugin default.' },
    rvcIndexRate: { title: 'RVC feature index rate', description: '0..1, defaults to 0.3 (same as the RVC API). Higher sticks closer to the target timbre but may pull in the training set\u0027s articulation; 0.4–0.6 usually makes singing conversion more obvious.' },
    rvcProtect: { title: 'RVC protect', description: '0..0.5, defaults to 0.33. How much of the original consonants and breath is kept: higher sounds more like Qixuan, lower sticks closer to the target timbre.' },
    runtimeDir: { title: 'gpt-sovits runtime folder', description: 'Base of the derived venv; empty picks the newest one in the deployment. Click Restart engine after changing it.' },
    pythonPath: { title: 'Derived venv python.exe', description: 'Empty uses venv\\Scripts\\python.exe under the plugin data folder. Click Restart engine after changing it.' },
    voicebankDir: { title: 'Voicebank folder', description: 'The unpacked Qixuan voicebank (including dsvocoder); empty uses voicebank under the plugin data folder. About 451 MB, installed from the panel on first use. Click Restart engine after changing it.' },
    voicebanksDir: { title: 'Voicebank library folder', description: 'Every subfolder with a dsconfig.yaml counts as one voicebank. Point it at a folder such as D:\\models\\diffsinger-voicebanks and the Voicebank dropdown lists them by name; empty uses voicebanks under the plugin data folder. Click Restart engine after changing it.' },
    voicebank: { title: 'Voicebank', description: 'Pick one from the library; the dropdown labels each with its languages and colours. Empty falls back to the Voicebank folder above. The next line is sung with the new voicebank, no restart needed (if it fails to load, the previous one keeps singing).' },
    voiceColor: { title: 'Voice colour', description: 'Extra colours shipped inside the voicebank (e.g. Normal / Soft); empty uses the first one. Takes effect on the next line, no restart needed.' },
    httpApi: { title: 'Serve the local singing API', description: 'For other plugins and online LLMs: POST /sing with lyrics and get a wav back. Loopback only. Click Restart engine after changing it.' },
    httpPort: { title: 'API port', description: 'Defaults to 9882; change it if something else uses that port. Click Restart engine after changing it.' },
    httpToken: { title: 'API token', description: 'Empty means no check (loopback only). When set, callers must send Authorization: Bearer or ?token=. Click Restart engine after changing it.' },
  },
};

export function configGroups(language: Language): ConfigGroup[] {
  const t = pick(language, TEXT);
  const owner = `world:${SINGER_ID}`;
  return [
    {
      id: owner,
      owner,
      schema: {
        type: 'object',
        title: t.groupSing.title,
        description: t.groupSing.description,
        properties: {
          [`${K}.bpm`]: { type: 'number', title: t.bpm.title, description: t.bpm.description, minimum: BPM_MIN, maximum: BPM_MAX, multipleOf: 1 },
          [`${K}.keyShift`]: { type: 'number', title: t.keyShift.title, description: t.keyShift.description, minimum: KEY_SHIFT_MIN, maximum: KEY_SHIFT_MAX, multipleOf: 1 },
          [`${K}.scale`]: { type: 'string', title: t.scale.title, description: t.scale.description, 'x-options': SCALE_OPTIONS },
        },
      },
    },
    {
      id: `${owner}:rvc`,
      owner,
      schema: {
        type: 'object',
        title: t.groupRvc.title,
        description: t.groupRvc.description,
        properties: {
          [`${K}.rvcEnabled`]: { type: 'boolean', title: t.rvcEnabled.title, description: t.rvcEnabled.description },
          [`${K}.rvcEndpoint`]: { type: 'string', title: t.rvcEndpoint.title, description: t.rvcEndpoint.description },
          [`${K}.rvcVoice`]: { type: 'string', title: t.rvcVoice.title, description: t.rvcVoice.description },
          [`${K}.rvcIndexRate`]: { type: 'number', title: t.rvcIndexRate.title, description: t.rvcIndexRate.description, minimum: RVC_INDEX_MIN, maximum: RVC_INDEX_MAX, multipleOf: 0.05, 'x-hot': true },
          [`${K}.rvcProtect`]: { type: 'number', title: t.rvcProtect.title, description: t.rvcProtect.description, minimum: RVC_PROTECT_MIN, maximum: RVC_PROTECT_MAX, multipleOf: 0.05, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}:service`,
      owner,
      schema: {
        type: 'object',
        title: t.groupService.title,
        description: t.groupService.description,
        properties: {
          [`${K}.autoStart`]: { type: 'boolean', title: t.autoStart.title, description: t.autoStart.description, 'x-hot': false },
          [`${K}.tier`]: { type: 'string', title: t.tier.title, description: t.tier.description, 'x-options': TIER_OPTIONS, 'x-hot': false },
          [`${K}.device`]: { type: 'string', title: t.device.title, description: t.device.description, 'x-options': DEVICE_OPTIONS, 'x-hot': false },
          [`${K}.runtimeDir`]: { type: 'string', title: t.runtimeDir.title, description: t.runtimeDir.description, 'x-path': { kind: 'directory' }, 'x-hot': false },
          [`${K}.pythonPath`]: { type: 'string', title: t.pythonPath.title, description: t.pythonPath.description, 'x-path': { kind: 'file', extensions: ['.exe'] }, 'x-hot': false },
          [`${K}.voicebankDir`]: { type: 'string', title: t.voicebankDir.title, description: t.voicebankDir.description, 'x-path': { kind: 'directory' }, 'x-hot': false },
          [`${K}.voicebanksDir`]: { type: 'string', title: t.voicebanksDir.title, description: t.voicebanksDir.description, 'x-path': { kind: 'directory' }, 'x-hot': false },
          [`${K}.voicebank`]: { type: 'string', title: t.voicebank.title, description: t.voicebank.description, 'x-options': BANK_OPTIONS, 'x-hot': true },
          [`${K}.voiceColor`]: { type: 'string', title: t.voiceColor.title, description: t.voiceColor.description, 'x-options': COLOR_OPTIONS, 'x-hot': true },
          [`${K}.httpApi`]: { type: 'boolean', title: t.httpApi.title, description: t.httpApi.description, 'x-hot': false },
          [`${K}.httpPort`]: { type: 'number', title: t.httpPort.title, description: t.httpPort.description, minimum: 1, maximum: 65535, multipleOf: 1, 'x-hot': false },
          [`${K}.httpToken`]: { type: 'string', title: t.httpToken.title, description: t.httpToken.description, 'x-hot': false },
        },
      },
    },
  ];
}

export function worldLabel(language: Language): string {
  return pick(language, TEXT).title;
}

/** 推理档下拉的选项；与 gpt-sovits 的「自动 / 显卡 / CPU」同一个口径。 */
export function tierOptions(language: Language): Array<{ value: SingerTier; label: string }> {
  const t = pick(language, TEXT);
  return [
    { value: 'auto', label: t.tierAuto },
    { value: 'cuda', label: t.tierCuda },
    { value: 'cpu', label: t.tierCpu },
  ];
}

/** 推理设备下拉。 */
export function deviceOptions(language: Language): Array<{ value: SingerDevice; label: string }> {
  const t = pick(language, TEXT);
  return [
    { value: 'auto', label: t.deviceAuto },
    { value: 'cuda', label: t.deviceCuda },
    { value: 'cpu', label: t.deviceCpu },
  ];
}

/** 调式下拉。 */
export function scaleOptions(language: Language): Array<{ value: SingerScale; label: string }> {
  const t = pick(language, TEXT);
  return [
    { value: 'major', label: t.scaleMajor },
    { value: 'minor', label: t.scaleMinor },
  ];
}
