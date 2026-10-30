# DiffSinger 唱歌 · 绮萱

Coopanion 的 `kind: world` 插件：**一句中文歌词进，一段 wav 出**。旋律由程序按调式自动生成，歌声由 DiffSinger +「绮萱」声库在本机推理，不联网、不训练。

- 面板「演唱」直接试听、下载 wav；
- 另开一个只监听 `127.0.0.1` 的 HTTP 接口（默认 `:9882`），其他插件与外部大模型用 **纯 JSON** `POST /sing` 就能拿到音频；
- 可选把干声再送进 RVC 插件换音色（默认关闭，RVC 不在线时自动退回绮萱原声）。

## 链路

```
歌词 → 标点断句 → 每字/每词取音素（中文查拼音，日语查声库自带假名词典，英语查声库自带英语词典）
     → 按调式生成旋律（五声音阶）
     → DS 段落（ph_seq / ph_num / note_seq / note_dur）
     → diffsinger_utau 五段推理（dur → pitch → variance → acoustic → vocoder）→ wav
```

常驻 Python worker 只在启动时载入声库的五个 ONNX，之后每首歌只走推理；Node 侧通过 stdin/stdout 各一行 JSON 驱动（见 `src/engine.ts` 顶部协议）。推理走 onnxruntime 的 CPU provider（`diffsinger_utau` 目前不暴露 device 参数），显卡档只影响派生 venv 借用的运行时。

## 前置

- Windows x64，Node ≥ 22；
- 一套共享 Python 运行时（含 torch / onnxruntime / librosa / ffmpeg）：**优先复用**部署里 `runtimes/gpt-sovits/` 下的任意一档（谁装的都行）；
  没有的话，点面板「安装」会自己下一份 CPU 档（约 1 GB，装到同一位置，和 gpt-sovits / RVC 共用），所以不装 gpt-sovits 插件也能单用。
- 派生 venv 用 `python -m venv --system-site-packages` 从这套运行时长出来，只补 `diffsinger-utau==0.3.8`，不改共享运行时。

## 首次安装

模型不随包分发。打开面板「服务」→「安装依赖与声库」：

1. 缺共享运行时的话先下它（CPU 档约 1 GB，ModelScope 优先、GitHub 兜底，SHA-256 校验后解压）；
2. 建派生 venv 并补 `diffsinger-utau`（先走阿里云镜像，失败自动回官方 PyPI）；
3. 下载绮萱声库（约 401 MB）与社区声码器（约 50 MB），断点续传，校验字节数与 SHA-256 后落位；
4. 用派生 venv 的 Python 标准库就地解压：声库解到数据目录 `voicebank/`，声码器解到 `voicebank/dsvocoder/`，指纹文件（`dsconfig.yaml`、`dsvocoder/vocoder.yaml`）齐了才算装完，然后删掉两个压缩包；
5. 自动拉起引擎。

装依赖前会先停引擎——worker 在跑时 `pip` 覆盖不了 venv 里的 `.pyd/.dll`。

数据目录（`<Coopanion 数据目录>/singer/`）：

```
venv/        派生 venv
voicebank/   绮萱声库 + dsvocoder/
tmp/         每次演唱的临时 wav（结束即删）
out/         勾选「保存」时的成品
```

## 推理服务手动启停

挂载时会自动拉起推理服务；面板「服务」里也可以手动停掉再启回来：

- **停止服务**：只停引擎和本机 HTTP 接口，World 仍挂载，引擎占的约 1.3 GB 内存释放；
- **启动服务**：按当前配置重新载入（约 4–11 秒），接口跟着回来；
- **重启引擎**：服务停着时点它也会把服务启回来，并按当前配置重新监听 HTTP（端口 / 令牌 / 开关一起生效）；
- 服务停着时面板演唱与 `POST /sing` 都会提示「推理服务未启动」，环境提示词也会让模型先请主人点「启动服务」。

## HTTP 接口

默认 `http://127.0.0.1:9882`。配了令牌就要求 `Authorization: Bearer <token>` 或 `?token=<token>`。

```bash
curl -sS http://127.0.0.1:9882/health
curl -sS http://127.0.0.1:9882/sing          # 自描述参数表，外部大模型读这一个就够

curl -sS -X POST http://127.0.0.1:9882/sing \
  -H "content-type: application/json" \
  -d '{"lyrics":"晚风吹过旧时光，我们一起走过那条街","bpm":96}' \
  -o sing.wav
```

不方便处理二进制时加 `"base64": true`，回 JSON（`audioBase64` 字段）：

```bash
curl -sS -X POST http://127.0.0.1:9882/sing \
  -H "content-type: application/json" \
  -d '{"lyrics":"晚风吹过旧时光","base64":true}' | jq -r .audioBase64 | base64 -d > sing.wav
```

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `lyrics` | string，必填 | — | 要唱的歌词，最长 2000 字；中文写汉字、日语写假名（要配合日语声库）、英语写单词（要配合带英语词典的声库），标点断句，其余字符不唱 |
| `bpm` | int | 96 | 60..200；每字半拍、句末一字一拍 |
| `keyShift` | int | 0 | −12..12，半音 |
| `scale` | string | `major` | `major` / `minor` |
| `seed` | int | 0 | 0 表示按歌词固定取值：同一歌词同一条旋律 |
| `pitchSteps` | int | 10 | 1..100，音高扩散步数 |
| `varianceSteps` | int | 10 | 1..100 |
| `acousticSteps` | int | 20 | 1..100，小一点更快、更糙 |
| `gender` | number | 0 | −1..1，音色性别参数 |
| `maxSeconds` | number | 60 | 1..300，超长截断乐句 |
| `speaker` | string | 空 | 多说话人声库才有意义；空为第一个 |
| `save` | bool | false | 另存到 `out/`，响应头 `x-singer-saved` 给路径 |
| `base64` | bool | false | 回 JSON 而非 `audio/wav` |

成功时默认回 `audio/wav`，响应头带 `x-singer-ms` / `x-singer-seconds` / `x-singer-sample-rate` / `x-singer-notes` / `x-singer-rvc`。

错误码：`400` 参数、`401` 令牌、`409` 引擎未就绪、`502` 推理失败、`503` 队列满（并发 1，排队上限 4）。

## 和其他两个插件一起用

这三个是本机一条完整的声音链路，可以单独装，也可以一起装：

| 插件 | 端口 | 作用 | 启动占用 |
| --- | --- | --- | --- |
| **gpt-sovits**（更好的 GPTSovits 语音） | `:9880` | 说话：文字 → 语音，本机外放，或交给 QQ | 显卡档约 2–3 GB 显存（按需加载后 1.5–2.5 GB）；CPU 档约 4–6 GB 内存 |
| **RVC**（RVC 变声） | `:9881` | 把干声换成小肥鱼 / 星落落大肥鱼的音色 | 显卡档约 1 GB 显存、内存约 2.5 GB（实测）；启动约 25–30 秒 |
| **本插件**（DiffSinger 唱歌） | `:9882` | 唱歌：歌词 → 绮萱的歌声 | 纯 CPU，内存约 1.3 GB、不占显存（实测）；引擎载入约 7–11 秒 |

配合方式：

- **说话**走 gpt-sovits；**唱歌**走本插件；
- 想让歌声也换成你训练的音色，把本插件的「RVC 后处理」打开（`indexRate` / `protect` 可调）；
- QQ 里点歌是「gpt-sovits 的语音接口收到 `【唱】` → 转给本插件 → 唱好回传」，所以三个插件要同时在运行。

## 在 QQ 里唱歌

和 gpt-sovits 插件（0.5.19 起）配合，QQ 里的语音回复可以直接变成一条唱歌语音条：

1. gpt-sovits 开着「开放本地语音接口」（默认 9880），QQ 插件的「语音模型网址」指向它——这是它原本就有的语音链路，不用改；
2. gpt-sovits 的「与其他插件联动」→「唱歌插件地址」默认就是本插件 `http://127.0.0.1:9882`；
3. bot 用 `qq_send` 发一条 `voice: true` 的消息，正文只写 `【唱】晚风吹过旧时光`。

gpt-sovits 的语音接口看到正文以 `【唱】`（也接受 `[唱]` / `[sing]`）开头就转给本插件唱，把 WAV 交回 QQ；
唱不出来时（本插件没装、引擎没就绪）自动按普通语音念，正常语音回复不受影响。

本插件随包带一条环境提示词（`prompts/env.md`）在教 bot 这套写法（歌词 8–16 字、那条消息别夹别的话），
可以在设置的提示词页里查看和改写。

## 唱日语

唱中文用绮萱；想唱日语，把「声库目录」指向一个日语 DiffSinger 声库（面板「服务」→ 声库目录，或配置 `worlds.singer.voicebankDir`），歌词改写成**假名**：

- 一拍一个假名；拗音（きゃ / しゃ）并成一个音符，促音「っ」挂到下一个音符，长音符「ー」把前一个元音拖长；
- 汉字**不唱**（没有读音表，会被跳过），所以日语歌词请写平假名 / 片假名；
- 声库自带 `dsdur/dsdict.yaml`（或 `dsdict-ja.yaml`）就能用，假名词典直接从声库里读；
  老式 Shift-JIS 的 `character.yaml` / `character.txt`、以及只写 `color`+`suffix` 的 `subbanks`，
  worker 启动时会自动修好，不用手动改包；
- 一个引擎一次只加载一个声库，换语言就是换目录；中文声库不受影响（没有假名词典，照旧按汉字唱）。

实测：欲音ルコ♀ DiffSinger Ver.2.00（`さくら さくら やよいのそら` → 5.1 s 音频，CPU 推理约 4.5 s，引擎载入约 6 s）。
该声库的条款：自用与非商用自由；商用需事先问 Long Sleeper，但同人个人活动的收益不用问；
当作别的角色的声线发布时要尽量标注声源「欲音ルコ」；禁止再配布，禁止拿模型数据去训练别的模型。

## 唱英语

英语按**单词**切分（空格分词），音标查声库自带英语词典（`dsdur/dsdict-en.yaml`，或单一 `dsdict.yaml` 里的英语条目）：

- 一个词按元音核切音节：单音节词一个音符，多音节词几个音符；词尾辅音留在最后一个音节，不吞词；
- 词典查不到的词（拼错、生僻词）兜底成**一个音符**的弱元音，整句照唱，不会报错；
- 声库的音素表里得真有 `en/*`，否则语言会退回声库的第一个语言，唱出来的味道不对；
- 绮萱 v2.7.0 自带 27 MB、约 26.8 万条的英语词典，流式扫描、按歌词里的词缓存（实测约 0.45 s，不额外下载）。

实测（绮萱 v2.7.0）：`twinkle twinkle little star, how I wonder what you are` → 5.341 s 音频、15 音符、
CPU 推理 6.2 s、引擎载入 2.8 s。Hanami Beta2 是 reflow 训练 + 自研 `titaniagan` 声码器，`diffsinger_utau 0.3.8`
载入即报缺 `dsvariance/dsconfig.yaml`，暂不支持。

## 多声库与音色

一个引擎一次只加载一个声库，但可以放很多个、在设置里挑：

- **声库总目录**（配置 `voicebanksDir`，面板「服务」里也能看到）：每个子目录算一个声库（里面要有 `dsconfig.yaml`）；
  留空是插件数据目录下的 `voicebanks`。本机现在放在 `D:\models\diffsinger-voicebanks`。
- **声库**（`voicebank`）：下拉里每项都标了 `名称（语言 · 音色）`，例如
  `DiffSinger 欲音ルコ♀ Ver.2.00（日语 · Normal / Soft）`、`绮萱_v2.7.0（中文）`；
  留空则退回单个「声库目录」（老行为，默认绮萱）。
- **音色**（`voiceColor`）：声库自带的多音色，如 `Normal` / `Soft`；留空用第一个。
- 换声库/音色**不用重启引擎**：world 内部自己重建 engine，下一句直接唱新声库；
  正在唱的那一句不打断，切换等它唱完（最多等 3 分钟）。新引擎起不来就退回上一个声库，
  面板引擎行会写一行黄字说明原因（例如声库目录里没有 `dsconfig.yaml`），唱歌不受影响。
  只换音色不重建引擎，下一句带上新 `speaker` 就行。
- 面板「服务」里还会把总目录扫到的声库列出来，`●` 是当前生效的那个。
- 语言标签只标引擎真能吃下的：中文走拼音表；日语要求声库自带**小**假名词典（几十 KB～几 MB），
  绮萱这类多语言声库的 `dsdict-ja.yaml` 有 14 MB、十几万条、不是逐假名条目，解析要 90 秒还对不上，
  所以不认，仍按中文唱；英语认 `dsdur/dsdict-en.yaml`（或含英语条目的单一 `dsdict.yaml`）。

实现上，四个预测阶段（dur / pitch / variance / acoustic）各有一份「同后缀不同前缀」的说话人表，
库只把同一个字符串传给四者，直接传必然只有一处命中、其余静默退回第一个音色；
worker 在启动时给每个阶段包了一层，按后缀把 `variance_Soft` 换成它自己表里的 `acoustic_Soft`
（实测：Normal 与 Soft 的同一句 rms 0.055 / 0.035，音色确实不同）。

## 配置（`worlds.singer`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tier` | `auto` | `auto` / `cuda` / `cpu`；决定派生 venv 基于哪一档运行时，改档后点「重启引擎」自动重建 |
| `runtimeDir` | 空 | gpt-sovits 运行时目录；空为自动挑部署里最新的 |
| `pythonPath` | 空 | 派生 venv 的 python.exe；空为数据目录 `venv\Scripts\python.exe` |
| `voicebankDir` | 空 | 声库目录；空为数据目录 `voicebank` |
| `voicebanksDir` | 空 | 声库总目录（每个子目录一个声库）；空为数据目录 `voicebanks` |
| `voicebank` | 空 | 从总目录里选的声库文件夹名；空则用 `voicebankDir` |
| `voiceColor` | 空 | 音色（`Normal` / `Soft`…）；空用第一个 |
| `bpm` / `keyShift` / `scale` | 96 / 0 / `major` | 面板与接口的默认值 |
| `rvcEnabled` | false | 干声再过一遍 RVC |
| `rvcEndpoint` | `http://127.0.0.1:9881` | RVC 插件接口地址 |
| `rvcVoice` | 空 | `.pth` 名（不含扩展名）；空用 RVC 插件的默认音色 |
| `httpApi` / `httpPort` / `httpToken` | true / 9882 / 空 | 本机接口开关、端口、令牌 |

生效时机：`voicebank` / `voiceColor` 改了下一句就生效（换声库失败会自动退回上一个）；
`tier` / `runtimeDir` / `pythonPath` / `voicebankDir` / `voicebanksDir` / `httpApi` / `httpPort` / `httpToken`
改完在面板点「重启引擎」生效（设置页也会标「重启生效」）。`bpm` / `keyShift` / `scale` 与 RVC 参数每句现读。

## 开发

```bash
npm install        # 或 pnpm install
npm run typecheck
npm test
npm run build      # 重建 dist/webui.js 与 dist/webui.css
npx tsx scripts/smoke.mts   # 真实链路：起 World → /health → POST /sing → 面板再唱一次
```

`scripts/smoke.mts` 可用环境变量覆盖路径：`SINGER_SMOKE_PYTHON`、`SINGER_SMOKE_BANK`、`SINGER_SMOKE_RUNTIME`、`SINGER_SMOKE_LYRICS`。

## 许可与合规

- **绮萱 v2.7.0 声库**：上游完整、未改动分发；用该声库产出的音频可商用；禁止逆向、格式转换、拆分/合并/蒸馏权重；再分发必须完整未改动且免费。见 [上游发布页](https://github.com/yqzhishen/qixuan-diffsinger/releases/tag/v2.7.0) 内附的使用条款。
- **社区声码器 PC-NSF-HiFiGAN 2025.02**：**CC BY-NC-SA 4.0，仅限非商业用途**。见 [OpenVPI Vocoders](https://openvpi.github.io/vocoders/)。
- AI 合成的歌声请自行在发布内容中标注。
