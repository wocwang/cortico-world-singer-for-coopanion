# 更新记录

## 0.1.15（2026-10-30）可关掉随 Coopanion 自动启动

**改了什么**

- 新增配置「随 Coopanion 启动服务」`autoStart`（默认开）：开着时插件挂载即拉起唱歌引擎与本机接口；
  关掉后插件仍加载，但服务保持停止（省内存），要用时在面板「服务」点「启动服务」。
- 这只决定下次启动 Coopanion 时的初始状态；当前这次随时可以用面板的启动 / 停止，
  「重启引擎」也照旧会把服务拨回开启。
- 关掉自动启动时，后台的依赖检查（含补装 `onnxruntime-gpu`）照常做，只是不会顺手拉起引擎。
- 市场显示名改为「DiffSinger唱歌」（英文 `DiffSinger Singing`），去掉「-绮萱」——现在已支持多个声库。

`tests/service.test.ts`（新增 1 个）：关掉后挂载不拉服务、`state.service = false`、手动启动仍能就绪。
一级验证 `pnpm typecheck && pnpm test`：75 个用例全绿。

## 0.1.14（2026-10-30）显卡档（自动）

**改了什么**

- 新增配置「推理设备」`device`（`auto` / `cuda` / `cpu`，默认 `auto`）：显卡档运行时的
  `torch/lib` 带 CUDA / cuDNN，派生 venv 再补 `onnxruntime-gpu==1.22.0`（约 215 MB，阿里云镜像优先），
  worker 启动时把 venv 的 site-packages 插到 `sys.path` 最前（盖住共享运行时里的 CPU 版 onnxruntime），
  五个 ONNX 都挂 CUDA provider；缺任何一样（没有 NVIDIA、没有显卡档运行时、没装 GPU 版、
  CUDA / cuDNN 加载失败）都自动退回 CPU。
- 卷积搜索固定 `HEURISTIC`：默认的 `EXHAUSTIVE` 会在第一句花 57 秒做算法搜索，`HEURISTIC` 只要 1.8 秒。
- 载入后先热身一句短句（只限显卡），把首跑的一次性开销挪到启动阶段；热身失败不影响就绪。
- `engine.ts` 把设备名传给 worker，并在 PATH 里加上运行时的 `torch/lib`（CUDA / cuDNN 依赖）。
- 面板引擎行显示「显卡推理 / CPU 推理」，`ready` 回执里的 `device` 现在是实际生效值（原先固定 `cpu`）。
- 配置「推理档」文案说明它只决定借哪套运行时，是否用显卡看「推理设备」。

**实测**（RTX 5070 Ti Laptop + 绮萱，5.96 秒歌、acousticSteps=20）

| 设备 | 载入 | 热跑 | 显存增量 |
| --- | --- | --- | --- |
| CPU | 2.9 s | 4.8 s/句 | 0 |
| 显卡（HEURISTIC） | 3.3 s + 热身 5.2 s | 0.7 s/句 | 约 0.8 GB |

正常长度的歌词连唱三次，CPU / 显卡的音高与时长一致（F0≈329 Hz、2.519 s）。
单字歌词（如「啊」）本身在这套声库里 pitch 预测不稳定，CPU 与显卡都会偶尔落到 midi 0，与本档改动无关。

`tests/venv.test.ts` + `tests/service.test.ts`（新增 3 个）：GPU 依赖版本、不需要显卡时不探测、
设备名交给引擎；一级验证 `pnpm typecheck && pnpm test`：74 个用例全绿。

## 0.1.13（2026-10-30）桌宠本机发声

**改了什么**

- 新增工具 `singer_sing`：桌宠 / 对话页里 Coo 唱歌不再经过 gpt-sovits 的 `sovits_speak`，
  由本插件合成后直接写进本机声卡（随包 audify/RtAudio，Windows WASAPI，系统默认设备、满音量），
  第一块 PCM 写进输出流之后才回执。整段最多等 60 秒：DiffSinger 是整句批式合成，超时先回「还在准备」，
  合成不取消，就绪后照常出声。
- 工具说明与环境提示词按 Pal-AI-Lab/Coopanion#538 的写法：要求模型在同一次回复里先调 `singer_sing`、
  紧接着调 `pet_say`、不等回执——Cortico 按顺序执行同一批工具调用，气泡正好在声音响起时出现。
  不写「返回时声音已开始」，否则模型会拆成两次回复，气泡反而更晚。
- QQ 点歌链路不变（`qq_send` + `voice: true` + 正文「【唱】」仍由语音通道转给本插件 HTTP 接口）；
  提示词补充：QQ 里不要调 `singer_sing`（它只在本机外放）。
- `describe.json` 重新生成，登记 `singer_sing`（tools 1 / events 0 / prompts 1）。
- 包体新增 `vendor/audify`（6 个文件约 840 KB，含 audify / RtAudio / Opus 的许可证），`files` 已随包发布。
- 服务停着时工具回「no sound」并提示主人点「启动服务」；缺 `lyrics`、合成失败、播放失败都回可读的失败回执，
  HTTP 接口、面板、QQ 唱歌链路不受影响。

`tests/player.test.ts` + `tests/tool.test.ts`（10 个）：播放器 `upmix` / wav 头解析、工具注册、
服务停、缺歌词、正常写入播放器、播放失败。一级验证 `pnpm typecheck && pnpm test`：71 个用例全绿。

## 0.1.12（2026-10-30）推理服务手动启停

**改了什么**

- 面板「服务」新增「启动服务 / 停止服务」：停掉只关引擎与本机 HTTP 接口，World 仍挂载，
  引擎占的约 1.3 GB 内存释放；再点「启动服务」按当前配置重新载入（约 4–11 秒）。
- 「重启引擎」在服务停着时也会把服务启回来，并按当前配置重新监听 HTTP（端口 / 令牌 / 开关一起生效）。
- 服务停着时面板与 `POST /sing` 都不再假装能唱：`state.service = false`，面板引擎行显示「已停」，
  接口调用回「推理服务未启动」，环境提示词里的状态也会让模型先请主人点「启动服务」。
- 配置 `x-hot` 按实际生效时机修正：`voicebank` / `voiceColor` 仍是改完下一句生效；
  `tier` / `runtimeDir` / `pythonPath` / `voicebankDir` / `voicebanksDir` / `httpApi` / `httpPort` / `httpToken`
  改为「重启引擎生效」，不再错误地标成热更新。
- `describe.json` 重新生成，补上环境提示词全文（`prompts`），与代码里的自描述一致。
- `cortico.tags` 按 TAGS.md 校正：去掉未收录的 `singing`，补上 `creative` 与 `external-setup`（要另装 Python 运行时 / 声库）。

`tests/service.test.ts`（5 个）：挂载默认拉起、停止后不唱且状态可读、再次启动可唱、重复点启动不重复载入、
停止后重启引擎把服务拨回来。一级验证 `pnpm typecheck && pnpm test`：61 个用例全绿。

## 0.1.11（2026-10-29）声库热切换

**改了什么**

- 配置里换了声库（`voicebank`）后，world 内部自己重建 engine：下一句开唱前先起新引擎，
  新引擎 ready 才替换旧的，再停旧的；不用再点面板「重启引擎」，也不用重启进程。
- 正在唱的那一句不打断：所有演唱走一条串行链，切换排在当前句之后（queue 空了才切，最多等 3 分钟）。
- 新引擎起不来就退回上一个声库，`status.switchError` 给出可读原因（面板引擎行也会写一行黄字），
  且这个声库记住失败、不反复重试，唱歌整体不受影响。
- 只换音色（`voiceColor`）不重建引擎——声库的说话人表已经全量载入，下一句直接带新 `speaker`。
- 新增纯函数 `resolveVoicebankDir(cfg, dataDir)` 与可注入的 `createEngine` 工厂，方便单测。

**实测**（`diffsinger_utau 0.3.8` + 绮萱 v2.7.0 → 欲音ルコ♀ Ver.2.00，CPU）

| 顺序 | 声库 | 歌词 | 音频 | 推理 | 音符 |
| --- | --- | --- | --- | --- | --- |
| 首次载入 | 绮萱_v2.7.0 | — | — | ready 4223 ms | — |
| 第 1 句 | 绮萱_v2.7.0 | `twinkle twinkle little star` | 222252 B / 2.519 s | 3630 ms | 7 |
| 切到欲音ルコ | （新引擎载入 3320 ms） | — | — | — | — |
| 第 2 句 | 欲音ルコ♀ Ver.2.00 | `さくら さくら やよいのそら` | 359468 B / 4.075 s | 7439 ms | 12 |

第 2 句 `voicebankName = yokune-ruko-f-diffsinger-v2.00`、`switchError = null`；
两句都有声（rms 2085 / 1836，peak 8900 / 8362）。载入时间没有变差：新引擎 3.3 s 在旧引擎的
「约 6 s 首次载入」同一量级（后者含 venv 冷启动）。

`tests/switch.test.ts`（6 个）：切换成功、载入失败回退且不重试、只换音色不重建、正在唱的那句不被打断、
改回原声库不重复重建、`resolveVoicebankDir` 四种分支。

## 0.1.10（2026-10-29）英语 G2P

**改了什么**

- 英语按**单词**切分（空格分词），查声库自带的 `dsdur/dsdict-en.yaml`（也认单一 `dsdict.yaml` 里的英语条目），
  把 CMU/ARPABET 音标按「原样 → `en/前缀` → 去掉前缀 → 别名（`axr→er`、`ix→ih`、`el→l`…）」落到声库音素表上。
- 每个词按**元音核**切音节，一词一音符或数音符；词尾辅音留在最后一个音节，不吞词。
  词典里查不到的词兜底成**一个音符**的弱元音（`ax/ah/aa/…` 取声库有的第一个），整句不会崩。
- 大词典（绮萱的 `dsdict-en.yaml` 27 MB、约 26.8 万条）流式扫描、按歌词里的词集缓存，实测约 0.45 s；
  小词典整份载入。两种 YAML 写法（块状 `- grapheme: … phonemes:` 与一行流式 `- {grapheme: …, phonemes: […]}`）都认。
- `banks.ts` 的 `readLanguages` 一并识别英语声库，面板/配置里的语言标签会标 `英语`。

**实测**（绮萱 v2.7.0，自带 `dsdict-en.yaml`，`diffsinger_utau 0.3.8`，CPU）

- `twinkle twinkle little star, how I wonder what you are` → `ms 6243`、`seconds 5.341`、`notes 15`、`lang: en`；
  worker 日志 `语言: en`、`语言映射 {'en':1,'ja':2,'zh':3}`、`音素数量: 39`、`F0 252.75 ~ 406.84 Hz`、
  `英语词典扫描: 命中 3/3` 与 `6/6`（分两次断句）。
- 探针（不加载模型，只跑 G2P）`twinkle twinkle little star` → 7 音符（twinkle 切两音节）；
  `don't stop believing`、`how I wonder what you are` 均切分正确；`zzzz` / `qwrtp` 各兜底 1 音符。

**为什么没用 Hanami Beta2**：该声库是 reflow 训练 + 自研 `titaniagan` 声码器，没有 `dsvariance/` 目录，
`diffsinger_utau 0.3.8` 加载即抛
`FileNotFoundError: …\Hoshino Hanami -LoveSong- AI For DiffSinger [Beta2]\dsvariance\dsconfig.yaml`，
跑不通；改用绮萱自带的英语词典（无需额外下载）。詩音マコト ENG 在 BOOTH 需 pixiv 登录，本次没有下。

## 0.1.9 及以前

见 git 历史。
