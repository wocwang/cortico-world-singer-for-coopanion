# 待做（Backlog）

## 1. QQ 语音投递：可选「语音条 / wav 文件 / 两者」

**目标**：在 QQ 里对 bot 说「发文件」就发 wav 文件、说「语音」就发语音条，没说默认语音条；唱歌和说话都适用。

**现状（2026-10-28 调研）**

- `cortico-world-qq-final 0.6.36` 已有 `qq_file`（`send`），但它只发**文件资料库里已有的**文件：
  索引 `file-index.json` 只在 World 启动时加载一次，工具没有导入/重载动作，`send` 只按内存里的名字匹配。
  所以「自己生成的音频」进不了库，除非重启 World（不可行）。
- 出站标记只有 `[图片:…]`、`[表情包:…]`；`[文件:…]` 只用于入站展示。
- `cortico-world-qq-lite` + 功能包（`qq-voice` 等）的宿主 API 只有 `send/sendGroup/sendPrivate`，也没有发文件。
- NapCat 自身没问题：**正向 WS 在 `127.0.0.1:3001`**（token 在 `NapCatQQ Desktop/components/NapCatQQ/config/onebot11_<QQ>.json`），
  `send_*_msg` + `record` = 语音条；`upload_private_file` / `upload_group_file` = 文件。已实测通过（私聊发过 wav 文件）。

**候选方案**

- **A（推荐）**：新扩一个小 world，例如 `@wocwang/cortico-world-qq-audio-for-coopanion`
  - 工具 `qq_audio(to, text, as = voice|file|both)`：`text` 以 `【唱】` 开头 → 调 `:9882/sing`，否则 → 调 `:9880/v1/audio/speech`；
    再按 `as` 发 `record` 或 `upload_*_file`。
  - 配置：`napcatWsUrl`、`napcatToken`、默认格式。
  - 不碰 qq-final，也不动 gpt-sovits。
- **B**：同一套能力塞进 gpt-sovits（少一个扩展，但动语音主插件）。
- **C**：只留脚本，模型无法自己选。

**待决**：选 A / B / C；是否加每分钟限速；token 是否走 `ctx.secret()`（部署 `.env`）而不是明文配置。

## 2. DiffSinger 多语言（英 / 日）

- **日语已打通（0.1.5，2026-10-29）**：worker 启动时读声库自带的 `dsdur/dsdict-ja.yaml` / `dsdur/dsdict.yaml`
  （假名 → 音素，只收声库音素表里有的条目），歌词逐假名切分；拗音并一个音符、促音挂下一个音符、
  长音符「ー」续前一个元音；同时自动修老包的 Shift-JIS `character.yaml`/`character.txt` 与
  缺 `prefix`/`tone_ranges` 的 `subbanks`。实测欲音ルコ♀ DiffSinger v2.00：
  `さくら さくら やよいのそら` → 5.1 s 音频，CPU 推理 4.5 s，引擎载入 6 s。
  声库留在 `D:\models\diffsinger-voicebanks\yokune-ruko-f-diffsinger-v2.00`（解压后）。
- **英语已打通（0.1.10，2026-10-29）**：按空格分词，查声库自带的 `dsdur/dsdict-en.yaml`（也认单一 `dsdict.yaml`
  里的英语条目），CMU/ARPABET 音标按「原样 → `en/前缀` → 去前缀 → 别名（`axr→er`、`ix→ih`…）」落到声库音素表；
  每个词按元音核切音节、词尾辅音留末音节，未知词兜底 1 个音符的弱元音（整词给一个音符，不崩）。
  大词典（绮萱 27 MB / 26.8 万条）流式扫、按歌词词集缓存（约 0.45 s）。实测绮萱 v2.7.0：
  `twinkle twinkle little star, how I wonder what you are` → 5.341 s 音频、15 音符、推理 6.2 s、载入 2.8 s。
  Hanami Beta2（reflow + 自研 `titaniagan`）缺 `dsvariance/`，`diffsinger_utau 0.3.8` 载入即报
  `FileNotFoundError … dsvariance\dsconfig.yaml`，跑不通；詩音マコト ENG 在 BOOTH 需 pixiv 登录，未下。
- **多声库切换已做（0.1.6）**：配置 `voicebanksDir`（总目录）+ `voicebank`（选项带「名称（语言 · 音色）」）
  + `voiceColor`（Normal / Soft…），面板列出候选并标 ● 当前；四个预测阶段按后缀重映射音色名。
- **声库热切换已做（0.1.11，2026-10-29）**：world 内自己重建 engine，下一句直接唱新声库，不用点「重启引擎」；
  演唱串行化，正在唱的那句不打断，切换排到当前句之后（最多等 3 分钟）；新引擎起不来就退回上一个声库，
  `switchError` 给出可读原因并记住失败不重试；只换音色不重建。实测绮萱（`twinkle twinkle little star`
  → 2.519 s / 3630 ms）→ 欲音ルコ（`さくら さくら やよいのそら` → 4.075 s / 7439 ms，含新引擎载入 3320 ms），
  `switchError = null`。
- **推理服务手动启停已做（0.1.12，2026-10-30）**：面板「启动服务 / 停止服务」，停掉只关引擎与本机接口
  （World 仍挂载，约 1.3 GB 内存释放），再启动按当前配置重新载入；「重启引擎」也能把停掉的服务拨回来。
  配置 `x-hot` 按实际生效时机修正（声库/音色热改，路径/端口/令牌标「重启生效」），
  `describe.json` 补上环境提示词全文；`tests/service.test.ts` 5 个用例。
- **共享运行时可按需下载（0.1.8 / RVC 0.3.5）**：没有 `runtimes/gpt-sovits/<版本>/<档>` 时，
  唱歌下 CPU 档（约 1 GB）、RVC 按 `auto` 检测 NVIDIA 下显卡档（约 4.1 GB）或 CPU 档，
  布局与 gpt-sovits 一致，三个插件共用同一份。下载→SHA-256→tar 解压→`cortico-runtime.json` 有单测覆盖；
  **真机“全新部署只装一个”的完整下载还没实测**（要 1–4 GB）。
- 其他可选声库：Kuroki Kasori、Haaku Kyou / 把握キョウ、紅（日）、南宫颜·羽 V2.0（中英，百度网盘）、
  詩音マコト ENG（BOOTH，0 日元，日英双语，需 pixiv 登录）。

## 3. 仓库清理（待批准后执行）

- `spec.md` / `tasks.md` / `checklist.md` / `probe.md` 仍是 RVC 时期的内容；
- `src/voices.ts`、`tests/voices.test.ts` 是 RVC 残留；
- `package-lock.json`（仓库用 pnpm）；
- `agent-work/singer-probe/install-data`（约 420 MB）。
