#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
常驻 DiffSinger 推理 worker。

Node 侧（engine.ts）把 JSON 一行写进 stdin，worker 把 JSON 一行写回 stdout；
其余输出（含 diffsinger_utau 自己打印的进度）全部改道 stderr，免得污染协议。

一次 `sing` 的完整链路：
    歌词 → 按标点断句 → 每字/每假名/每词取音素（中文查拼音，日语查声库自带假名词典，
    英语查声库自带英语词典并按音节分音符）
         → 程序生成五声音阶旋律
         → DS 段落（note_seq / note_dur / ph_seq / ph_num）
         → diffsinger_utau（dur → pitch → variance → acoustic → vocoder）→ wav

协议：
- worker → Node：`{"type":"ready","voicebank":"...","sampleRate":44100}`
- worker → Node：`{"type":"result","id":1,"ok":true,"ms":123,"seconds":4.2,"notes":16,"sampleRate":44100}`
- worker → Node：`{"type":"result","id":1,"ok":false,"kind":"param|infer","error":"..."}`
- Node → worker：`{"op":"sing","id":1,"out":"...","lyrics":"...","bpm":96,...}`
- Node → worker：`{"op":"shutdown"}`
"""
import json
import hashlib
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

# stdout 只留给协议行；库里的 print 全部走 stderr。
_STDOUT = sys.stdout
sys.stdout = sys.stderr


def send(payload):
    _STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _STDOUT.flush()


# 五声音阶（相对主音的半音数）：大调 1 2 3 5 6，小调 1 b3 4 5 b7。
SCALES = {
    "major": [0, 2, 4, 7, 9],
    "minor": [0, 3, 5, 7, 10],
}

# 断句：只按句读断，空白留给各语言自己切（英语按空格分词，中日文忽略空白）。
PHRASE_SPLIT = re.compile(r"[，。！？、；：,.!?;:…—~～\[\]【】()（）\"“”‘’]+")
HAN = re.compile(r"[\u4e00-\u9fff]")
# 假名（平假名 + 片假名）：日语声库按「一拍一个假名」出音符。
KANA = re.compile(r"[\u3041-\u309f\u30a1-\u30ff]")
SMALL_KANA = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")
SOKUON = set("っッ")
LONG_VOWEL = "ー"
# 能重复成长音的音素：日语声库的元音音素大小写都可能有（`a` 与 `I`、`U`、`O`）。
VOWELS = set("aiueoAIUEO")
# 英语单词（含 don't 这类缩写）；按空格分词后逐词查声库自带的英语词典。
EN_WORD = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?")
# ARPABET / CMU 的元音（去掉 en/ 前缀与重音数字后），用来把一个单词切成音节。
EN_VOWELS = set(
    "aa ae ah ao aw ay ax axr eh er ey ih ix iy ow oy uh uw".split()
) | set("aeiou")


def kata_to_hira(text):
    """片假名转平假名（U+30A1–U+30F6 平移到 U+3041–U+3096，长音符不动）。"""
    return "".join(chr(ord(ch) - 0x60) if "\u30a1" <= ch <= "\u30f6" else ch for ch in text)


# 英语词典超过这个大小就按「歌词里出现的词」流式挑，不在启动时整份解析
# （绮萱的 dsdict-en.yaml 有 27 MB、220 万行，整份 safe_load 要几十秒）。
EN_DICT_MAX_BYTES = 4 * 1024 * 1024
# 词典/声库写法不一致时的小别名：只在原样、en/ 前缀、去前缀都查不到时再试。
EN_PHONEME_ALIASES = {
    "axr": "er", "ix": "ih", "el": "l", "em": "m", "hv": "hh", "vcl": "cl",
}


def en_word(raw):
    """词典里的 grapheme / 歌词里的单词统一成小写、直引号；不是单词返回空。"""
    text = str(raw or "").strip().lower().replace("’", "'")
    if not text or not EN_WORD.fullmatch(text):
        return ""
    return text


def arpabet_base(phoneme):
    """`en/AA1` / `AA` / `en/ax` → `aa` / `aa` / `ax`：判元音、找音节用。"""
    text = str(phoneme or "").lower()
    if "/" in text:
        text = text.split("/")[-1]
    return re.sub(r"[0-9]+$", "", text)


# 英语词典有两种写法：多语言声库（绮萱）是块状 `- grapheme:` + `  phonemes:`，
# OpenUtau 原生英语声库（Hanami）是一行流式 `- {grapheme: "...", phonemes: [...]}`。
EN_FLOW_ENTRY = re.compile(
    r'\{[^{}]*grapheme:\s*"((?:[^"\\]|\\.)*)"[^{}]*phonemes:\s*\[([^\]]*)\]'
)
# ARPABET 的双字母元音：日语词典里没有，用它区分「英语词典」和「日语词典」。
EN_ARPA_VOWELS = set("aa ae ah ao aw ay ax eh er ey ih iy ow oy uh uw".split())


def yaml_scalar(text):
    """词典里的一个 YAML 标量 → 字符串（去引号；单引号里的 `''` 是一个 `'`）。"""
    value = str(text or "").strip()
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace('\\"', '"')
    return value


def iter_en_entries(lines):
    """逐条吐 (grapheme, [phoneme])，两种词典写法都认；不整份解析 YAML。

    绮萱的 dsdict-en.yaml 有 27 MB、220 万行，`yaml.safe_load` 要几十秒，
    而一句歌词里出现的词就那么几个，按行挑比整份解析划算得多（扫一遍约 0.5 s）。
    """
    grapheme = None
    phones = []
    reading = False
    for line in lines:
        text = line.strip()
        flow = EN_FLOW_ENTRY.match(text)
        if flow:
            if grapheme and phones:
                yield yaml_scalar(grapheme), phones
            grapheme, phones, reading = None, [], False
            items = [yaml_scalar(p) for p in flow.group(2).split(",") if p.strip()]
            yield yaml_scalar(flow.group(1)), items
            continue
        if text.startswith("- grapheme:"):
            if grapheme and phones:
                yield yaml_scalar(grapheme), phones
            grapheme = text[len("- grapheme:"):]
            phones, reading = [], False
            continue
        if grapheme and text.startswith("phonemes:"):
            inline = text[len("phonemes:"):].strip()
            if inline.startswith("["):
                yield yaml_scalar(grapheme), [yaml_scalar(p) for p in inline.strip("[]").split(",") if p.strip()]
                grapheme, phones, reading = None, [], False
            else:
                reading = True
            continue
        if grapheme and reading:
            if text.startswith("- "):
                phones.append(yaml_scalar(text[2:]))
            elif not text or text.startswith("#"):
                continue
            else:  # 条目里出现别的字段：先收尾，别让后面别的段被当成本条的音素
                yield yaml_scalar(grapheme), phones
                grapheme, phones, reading = None, [], False
    if grapheme and phones:
        yield yaml_scalar(grapheme), phones


SPEAKER_PREFIXES = ("acoustic_", "variance_", "dur_", "pitch_")
# 假名词典的上限：单语言日语声库的词典只有几十 KB～几 MB；多语言声库那份十几 MB，
# 解析要一分半，而且条目不是逐假名的，直接不认。
JA_DICT_MAX_BYTES = 4 * 1024 * 1024


def speaker_suffix(name):
    """说话人名的音色后缀：`dsmain/embeds/acoustic/acoustic_Soft` → `Soft`。

    四个阶段（dur / pitch / variance / acoustic）各自有一份同名不同前缀的说话人表，
    而库只把同一个字符串传给四个阶段，所以按后缀互相认。
    """
    short = str(name or "").rsplit("/", 1)[-1]
    for prefix in SPEAKER_PREFIXES:
        if short.startswith(prefix):
            return short[len(prefix):]
    return short



MIDI_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(midi):
    octave = midi // 12 - 1
    return f"{MIDI_NAMES[midi % 12]}{octave}"


def prepare_device(requested):
    """按请求挑推理设备，返回实际能用的 `cuda` 或 `cpu`。

    显卡档要两件事都成立：派生 venv 里装了 onnxruntime-gpu，且共享运行时带着
    CUDA / cuDNN（torch/lib 走 PATH）。派生 venv 的 site-packages 必须排到共享运行时
    之前，否则 import 到的还是共享运行时里的 CPU 版 onnxruntime。
    """
    if requested not in ("auto", "cuda"):
        return "cpu"
    site = Path(sys.prefix) / "Lib" / "site-packages"
    if site.is_dir():
        sys.path.insert(0, str(site))
    try:
        import onnxruntime as ort
    except Exception as exc:
        print(f"onnxruntime 载入失败，改用 CPU：{exc}", file=sys.stderr)
        return "cpu"
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        print("没有 CUDA provider（派生 venv 里没装 onnxruntime-gpu，或 CUDA / cuDNN 不在 PATH），改用 CPU", file=sys.stderr)
        return "cpu"
    return "cuda"


def _force_basic_optimization(device="cpu"):
    """把 ORT 图优化降到 basic，并接管 provider（`cuda` 时挂 CUDA）。

    绮萱的声学模型（267 MB）在 onnxruntime 的 extended/all 级别优化时会原生崩溃
    （Windows 访问冲突 0xC0000005，1.19.2 与 1.22.0 都能复现），basic 级别正常。
    diffsinger_utau 自己建 SessionOptions，只能从这里包一层。

    device 是 `cuda` 时给每个 session 都挂 CUDA provider；第一次建 session 就失败
    （驱动 / cuDNN 缺失）时自动退回 CPU，最终生效的设备记在返回的 dict 的 `device` 上。
    """
    import onnxruntime as ort

    original = ort.InferenceSession
    state = {"device": device if device == "cuda" else "cpu"}

    def session(path_or_bytes, sess_options=None, **kwargs):
        options = sess_options or ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        if state["device"] == "cuda":
            try:
                # 默认的 EXHAUSTIVE 卷积搜索会在第一句上花掉几十秒；HEURISTIC 首句只要 1–2 秒。
                return original(
                    path_or_bytes,
                    sess_options=options,
                    providers=[
                        ("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
                        "CPUExecutionProvider",
                    ],
                )
            except Exception as exc:
                print(f"CUDA 推理不可用，回退 CPU：{exc}", file=sys.stderr)
                state["device"] = "cpu"
        return original(path_or_bytes, sess_options=options, providers=["CPUExecutionProvider"])

    ort.InferenceSession = session
    return state


def normalize_bank_text(bank_dir):
    """把声库根目录的元数据修成 diffsinger_utau 能读的样子。

    1. 日语声库（如欲音ルコ）的 character.yaml / character.txt 是 Shift-JIS，
       库用默认编码读会直接 UnicodeDecodeError 起不来 —— 统一转成 UTF-8。
    2. 老版 OpenUtau 的 subbanks 只写 `color` + `suffix`，而库里 SubBank 签名要求
       `color/prefix/suffix/tone_ranges` 四个都有，缺了就 TypeError —— 补默认值。
    """
    for name in ("character.yaml", "character.txt"):
        path = Path(bank_dir) / name
        if not path.is_file():
            continue
        raw = path.read_bytes()
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            for encoding in ("cp932", "shift_jis"):
                try:
                    text = raw.decode(encoding)
                except UnicodeDecodeError:
                    continue
                path.write_text(text, encoding="utf-8")
                print(f"声库元数据 {name} 从 {encoding} 转为 UTF-8", file=sys.stderr)
                break

    path = Path(bank_dir) / "character.yaml"
    if not path.is_file():
        return
    import yaml

    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        print(f"character.yaml 解析失败：{exc}", file=sys.stderr)
        return
    subbanks = data.get("subbanks") or []
    filled = [
        {
            "color": bank.get("color", ""),
            "prefix": bank.get("prefix", ""),
            "suffix": bank.get("suffix", ""),
            "tone_ranges": bank.get("tone_ranges") or [],
        }
        for bank in subbanks
    ]
    if subbanks and any(set(bank) != {"color", "prefix", "suffix", "tone_ranges"} for bank in subbanks):
        data["subbanks"] = filled
        path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
        print("character.yaml subbanks 补齐 prefix/tone_ranges", file=sys.stderr)


class Singer:
    def __init__(self, voicebank_dir, device="cpu"):
        self.voicebank_dir = Path(voicebank_dir)
        self.device = device
        self.device_state = {"device": device}
        self.pred = None
        self.replacer = None
        self.phoneme_set = None
        self.ja_dict = {}
        self.ja_dict_path = None
        # 英语词典：小词典整份读进 en_cache；大词典按歌词里的词流式扫，
        # 命中的词与未命中的词都缓存（None 表示查过但没有）。
        self.en_dict_path = None
        self.en_cache = {}
        self.en_full = False   # 小词典是否已整份读进 en_cache
        self.en_small = True
        self.sample_rate = 44100

    def load(self):
        normalize_bank_text(self.voicebank_dir)
        self.device_state = _force_basic_optimization(self.device)
        from diffsinger_utau.voice_bank import PredAll
        from diffsinger_utau.voice_bank.commons.ds_reader import DSTextReplacer

        self.pred = PredAll(self.voicebank_dir)
        self.replacer = DSTextReplacer()
        self.sample_rate = int(self.pred.dsvocoder.sample_rate)
        # 声学模型的音素表就是合法音素全集；查不到的音素会让 ONNX 直接报 KeyError。
        table = self.pred.dsacoustic.phonemes
        if table is not None:
            self.phoneme_set = set(table.content.keys())
        self.ja_dict_path = self.find_ja_dict()
        self.en_dict_path = self.find_en_dict()
        if self.en_dict_path is not None:
            self.en_small = self.en_dict_path.stat().st_size <= EN_DICT_MAX_BYTES
        self.install_color_router()
        return self.speaker_colors()

    def speaker_colors(self):
        """声库的音色（声学模型的说话人）短名：`Normal` / `Soft` …；单音色声库返回空。

        dsconfig 里的写法是 `dsmain/embeds/acoustic/acoustic_Normal`，取最后一段并去掉
        `acoustic_` 前缀，正好是 character.yaml 里 `color: '01:Normal'` 的后半段。
        """
        names = []
        for spk in self.speakers_raw():
            short = speaker_suffix(getattr(spk, "speaker_name", ""))
            if short:
                names.append(short)
        return names

    def speakers_raw(self):
        return list(getattr(self.pred.dsacoustic, "speakers", None) or [])

    def install_color_router(self):
        """把同一个音色名按后缀分发给四个阶段。

        库先按 dsdur 的名单校验 `speaker`，命中后原样传给四个阶段；但四个阶段各自的
        名字前缀不同（acoustic_Soft / variance_Soft），只有一个能对上，其余静默退回第一个
        音色——只传 acoustic 名就会看到「variance 退回 Normal、acoustic 又退回 Normal」。
        这里给每个阶段包一层：进来的是 `variance_Soft`，就换成它自己表里的 `acoustic_Soft`。
        """
        pred = self.pred
        for stage in (pred.pred_duration, pred.pred_pitch, pred.pred_variance, pred.pred_acoustic):
            box = None
            for attr in ("dsdur", "dspitch", "dsvariance", "ds_acoustic", "dsacoustic"):
                box = getattr(stage, attr, None)
                if box is not None:
                    break
            if box is None:
                continue
            original = stage.predict

            def predict(ds, _original=original, _box=box, **kwargs):
                kwargs["speaker"] = self.match_color(_box, kwargs.get("speaker"))
                return _original(ds, **kwargs)

            stage.predict = predict

    def match_color(self, box, wanted):
        """在一个阶段的说话人表里找同名后缀；找不到就原样返回（交给库里退回默认）。"""
        if not wanted:
            return wanted
        suffix = speaker_suffix(wanted)
        for spk in (getattr(box, "speakers", None) or []):
            name = str(getattr(spk, "speaker_name", "") or "")
            if speaker_suffix(name).lower() == suffix.lower():
                return name
        return wanted

    def resolve_speaker(self, wanted):
        """把面板/接口给的音色短名换成 `available_speakers` 里的名字。

        库只认 dsdur 名单里的字符串（不认就整套换回第一个），所以先在这里对齐，
        再由 install_color_router 分发到各阶段。
        """
        if not wanted:
            return None
        suffix = speaker_suffix(wanted)
        for name in (self.pred.available_speakers or []):
            if speaker_suffix(name).lower() == suffix.lower():
                return name
        return wanted

    def find_ja_dict(self):
        """声库里假名词典的路径（有就说明能唱假名）；只查文件在不在，不解析。

        词典是懒加载的：第一次真唱日语时才读。
        只收「单语言」的小词典（几十 KB～几 MB）：多语言声库（如绮萱）的 `dsdict-ja.yaml`
        有 14 MB、十几万条，解析要 90 秒，而且条目不是逐假名的，逐假名查根本对不上——
        与其卡住不如不认，仍按中文唱。
        """
        for name in ("dsdur/dsdict-ja.yaml", "dsdur/dsdict.yaml"):
            path = self.voicebank_dir / name
            if path.is_file() and path.stat().st_size <= JA_DICT_MAX_BYTES:
                return path
        return None

    def load_ja_dict(self):
        """读声库自带的假名词典：`dsdur/dsdict-ja.yaml` 优先，其次 `dsdur/dsdict.yaml`。

        DiffSinger 日语声库把「假名 → 音素」放在这里（欲音ルコ：644 条，含拗音与促音 `cl`），
        条目自带的音素已经是声库音素表里的写法，直接拿来就能喂给模型。
        只收音素全在音素表内的条目，多语言声库里的残留不会误用。
        """
        import yaml

        merged = {}
        for name in ("dsdur/dsdict-ja.yaml", "dsdur/dsdict.yaml"):
            path = self.voicebank_dir / name
            if not path.is_file():
                continue
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            except Exception as exc:  # 词典坏了不该拖垮整个引擎
                print(f"日语词典解析失败 {name}: {exc}", file=sys.stderr)
                continue
            for entry in data.get("entries") or []:
                grapheme = str(entry.get("grapheme") or "")
                phones = [str(p) for p in (entry.get("phonemes") or [])]
                if not grapheme or not phones or "/" in grapheme or " " in grapheme:
                    continue
                if self.phoneme_set is not None and any(p not in self.phoneme_set for p in phones):
                    continue
                merged.setdefault(grapheme, phones)
        if merged:
            print(f"日语假名词典: {len(merged)} 条", file=sys.stderr)
        return merged

    # ---------- 英语词典 ----------

    def find_en_dict(self):
        """声库里英语词典的路径（有就说明能唱英语）；只查文件在不在，不解析。

        `dsdur/dsdict-en.yaml` 优先；只有一份 `dsdict.yaml` 时，先看它到底是不是英语词典
        （欲音ルコ这类日语声库的 dsdict.yaml 里也有 `Edge`/`breath` 这种英文拼写条目，
        但音素是日语写法，不能拿来当英语词典用）。
        """
        path = self.voicebank_dir / "dsdur/dsdict-en.yaml"
        if path.is_file():
            return path
        plain = self.voicebank_dir / "dsdur/dsdict.yaml"
        if plain.is_file() and self.has_en_entries(plain):
            return plain
        return None

    def has_en_entries(self, path):
        """判断一份词典是不是英语词典：看前 300 条里有几条带 ARPABET 双字母元音。

        日语词典的音素是 `a`/`i`/`cl`/`N` 这种写法，没有 `ih`/`ow`，所以不会误判。
        """
        checked = 0
        hits = 0
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for grapheme, phones in iter_en_entries(handle):
                    if not phones or not en_word(grapheme):
                        continue
                    checked += 1
                    if any(arpabet_base(p) in EN_ARPA_VOWELS for p in phones):
                        hits += 1
                    if checked >= 300:
                        break
        except OSError as exc:
            print(f"英语词典预检失败 {path.name}: {exc}", file=sys.stderr)
            return False
        return hits >= 10 and hits >= checked * 0.3

    def load_en_small_dict(self):
        """小英语词典整份读进 en_cache（几十 KB～几 MB，条目不多，一次就够）。"""
        self.en_full = True
        found = {}
        try:
            with self.en_dict_path.open("r", encoding="utf-8", errors="replace") as handle:
                for grapheme, phones in iter_en_entries(handle):
                    key = en_word(grapheme)
                    if not key or key in found:
                        continue
                    mapped = self.en_phones(phones)
                    if mapped:
                        found[key] = mapped
        except OSError as exc:  # 词典读不了不该拖垮引擎，最多英语唱不出来
            print(f"英语词典读取失败 {self.en_dict_path.name}: {exc}", file=sys.stderr)
        self.en_cache.update(found)
        print(f"英语词典: {len(found)} 条（{self.en_dict_path.name}）", file=sys.stderr)

    def scan_en_dict(self, wanted):
        """大词典只挑歌词里出现的词：流式扫一遍（绮萱 27 MB 约 0.5 s），不做整份解析。

        命中的词记音素，没命中的词记 None —— 下一句再来同一个词就不必重扫。
        """
        found = {}
        try:
            with self.en_dict_path.open("r", encoding="utf-8", errors="replace") as handle:
                for grapheme, phones in iter_en_entries(handle):
                    key = en_word(grapheme)
                    if not key or key in found or key not in wanted:
                        continue
                    mapped = self.en_phones(phones)
                    if mapped:
                        found[key] = mapped
        except OSError as exc:
            print(f"英语词典读取失败 {self.en_dict_path.name}: {exc}", file=sys.stderr)
        self.en_cache.update(found)
        for word in wanted:
            self.en_cache.setdefault(word, None)
        print(f"英语词典扫描: 命中 {len(found)}/{len(wanted)} 个词", file=sys.stderr)

    def map_en_phone(self, phoneme):
        """词典里的一个音素 → 声库音素表里的写法；查不到返回空串。

        三种声库三种写法：绮萱是全前缀（`en/aa`）、Hanami 这类 OpenUtau 英语声库是裸
        ARPABET（`aa`）、多语言声库还可能只收 `zh/`。按「原样 → en/ 前缀 → 去前缀 → 别名」试。
        """
        text = str(phoneme or "").strip()
        if not text:
            return ""
        if self.phoneme_set is None:
            return text
        base = arpabet_base(text)
        candidates = [text, text.lower(), f"en/{base}", base]
        alias = EN_PHONEME_ALIASES.get(base)
        if alias:
            candidates.extend([f"en/{alias}", alias])
        for candidate in candidates:
            if candidate and candidate in self.phoneme_set:
                return candidate
        return ""

    def en_phones(self, raw):
        """词典里的一条音素列表 → 声库写法；有一个查不到就整条不要（免得 ONNX 报 KeyError）。"""
        mapped = [self.map_en_phone(p) for p in raw]
        if not mapped or any(not p for p in mapped):
            return []
        return mapped

    def en_fallback_phone(self):
        """未知词的兜底音素：挑一个声库里有的元音，整词只唱一个音符。

        宁可含糊一点也不能把词吞掉，更不能让 ONNX 收到表外音素直接报错。
        """
        for base in ("ax", "ah", "aa", "uh", "a", "e", "i", "o", "u"):
            mapped = self.map_en_phone(f"en/{base}")
            if mapped:
                return mapped
        return ""

    def en_lookup(self, words):
        """一批歌词单词 → {词: 音素}；词典里没有的词用兜底音素补上。"""
        wanted = [word for word in words if word]
        if self.en_small:
            if not self.en_full:
                self.load_en_small_dict()
        else:
            missing = {word for word in wanted if word not in self.en_cache}
            if missing:
                self.scan_en_dict(missing)
        fallback = self.en_fallback_phone()
        result = {}
        for word in wanted:
            phones = self.en_cache.get(word)
            if phones:
                result[word] = list(phones)
            elif fallback:
                result[word] = [fallback]
        return result

    # ---------- 词 → 音素 ----------

    def ja_phonemes(self, grapheme):
        """一个假名（或拗音）→ 音素；片假名转平假名再查一次。"""
        if not self.ja_dict and self.ja_dict_path:
            self.ja_dict = self.load_ja_dict()
        if not self.ja_dict:
            return []
        for form in (grapheme, kata_to_hira(grapheme)):
            phones = self.ja_dict.get(form)
            if phones:
                return list(phones)
        return []

    def ja_units(self, phrase):
        """日语切分：一拍一个假名；拗音并进前一个音符，促音挂到下一个音符，长音符续前一个元音。"""
        units = []
        pending_cl = False
        can_cl = self.phoneme_set is None or "cl" in self.phoneme_set
        for ch in phrase:
            if ch == LONG_VOWEL:
                if units:
                    phones = units[-1][1]
                    if phones and phones[-1] in VOWELS:
                        phones.append(phones[-1])
                continue
            if ch in SOKUON:
                pending_cl = can_cl
                continue
            if not KANA.match(ch):
                pending_cl = False
                continue
            if ch in SMALL_KANA and units and len(units[-1][0]) == 1:
                merged = units[-1][0] + ch
                phones = self.ja_phonemes(merged)
                if phones:
                    # 前一拍挂过促音（`cl`）时，并成拗音后要把 `cl` 留着。
                    if units[-1][1][:1] == ["cl"]:
                        phones = ["cl"] + phones
                    units[-1] = (merged, phones)
                    continue
            phones = self.ja_phonemes(ch)
            if not phones:
                continue
            if pending_cl:
                phones = ["cl"] + phones
                pending_cl = False
            units.append((ch, phones))
        return units

    def en_syllables(self, phones):
        """音素串 → 音节：一个音节一个元音核（唱一个音符），词尾辅音留在最后一个音节。

        切在元音处：元音之后到下一个元音之间的辅音算下一个音节的声母（英语更像
        "a-bout" 那种切法），末尾剩下的辅音自然留在最后一音节，不会被吞。
        整个词一个元音都没有（词典里的怪词）就退化成单个音节，整词一个音符。
        """
        syllables = []
        current = []
        has_vowel = False
        for phoneme in phones:
            if has_vowel and arpabet_base(phoneme) in EN_VOWELS:
                syllables.append(current)
                current = [phoneme]
                continue
            current.append(phoneme)
            if arpabet_base(phoneme) in EN_VOWELS:
                has_vowel = True
        if current:
            syllables.append(current)
        return syllables

    def en_units(self, phrase):
        """英语切分：按空格分词，一个词按音节拆成多个音符；词典里没有的词兜底成一个音符。"""
        words = [en_word(match.group(0)) for match in EN_WORD.finditer(phrase)]
        words = [word for word in words if word]
        if not words:
            return []
        lookup = self.en_lookup(words)
        units = []
        for word in words:
            phones = lookup.get(word) or []
            if not phones:
                continue
            for syllable in self.en_syllables(phones):
                units.append((word, syllable))
        return units

    def phrase_units(self, phrase):
        """一句歌词 → ([(grapheme, phones)], lang)。

        假名 → 日语词典；纯拉丁字母（不含汉字）→ 英语词典；其余按汉字逐字查拼音。
        """
        if self.ja_dict_path and KANA.search(phrase):
            return self.ja_units(phrase), "ja"
        if self.en_dict_path and not HAN.search(phrase) and EN_WORD.search(phrase):
            return self.en_units(phrase), "en"
        return [
            (char, phones)
            for char, phones in ((c, self.syllable_phonemes(c)) for c in HAN.findall(phrase))
            if phones
        ], "zh"

    def syllable_phonemes(self, char):
        """一个汉字 → 音素列表；不在词典或声库音素表里就返回空（这个字不唱）。

        声库的音素表是多语言的（`zh/an`、`en/aa`…），而 DSTextReplacer 给的是裸音素
        （`an`），这里补上 `zh/` 前缀再查表。`SP`/`AP` 这类控制符本身就不带前缀。
        """
        raw = self.replacer.get_phonemes(char, self.replacer.opencpop_dict)
        if not raw:
            return []
        if self.phoneme_set is None:
            return raw
        mapped = []
        for phoneme in raw:
            if phoneme in self.phoneme_set:
                mapped.append(phoneme)
            elif f"zh/{phoneme}" in self.phoneme_set:
                mapped.append(f"zh/{phoneme}")
            else:
                return []
        return mapped

    # ---------- 旋律 ----------

    def build_notes(self, lyrics, bpm, key_shift, scale, seed, max_seconds):
        """按句生成旋律；每字/每音节一个音符，句间插一个 SP 休止。返回 (notes, text, lang)。"""
        import random

        beat = 60.0 / max(40, bpm)
        scale_steps = SCALES.get(scale, SCALES["major"])
        rng = random.Random(seed)
        base = 60 + key_shift  # C4 起，移调后仍是同一调式

        phrases = [p for p in PHRASE_SPLIT.split(lyrics) if p]
        notes = []
        sung_text = []
        total = 0.0
        # 整首歌只给一个 lang（diffsinger_utau 的五个阶段都吃同一个）：按音符数最多的语言。
        lang_counts = {}

        for phrase in phrases:
            units, lang = self.phrase_units(phrase)
            if not units:
                continue
            lang_counts[lang] = lang_counts.get(lang, 0) + len(units)
            # 每个乐句在五声音阶里走一段：起点随机，步进 ±1/0，靠拢中间音。
            degree = rng.randrange(len(scale_steps))
            octave = 4
            for index, (grapheme, phonemes) in enumerate(units):
                dur = beat * (1.0 if index == len(units) - 1 else 0.5)
                if total + dur > max_seconds:
                    break
                midi = base + 12 * (octave - 4) + scale_steps[degree]
                notes.append({
                    "phones": phonemes,
                    "midi": midi,
                    "dur": dur,
                    "rest": False,
                })
                sung_text.append(grapheme)
                total += dur
                step = rng.choices([-1, 0, 1], weights=[3, 4, 3])[0]
                if degree + step < 0 or degree + step >= len(scale_steps):
                    step = -step
                degree += step
                if degree >= len(scale_steps):
                    degree -= len(scale_steps)
                    octave = min(5, octave + 1)
                elif degree < 0:
                    degree += len(scale_steps)
                    octave = max(3, octave - 1)
            if total + beat * 0.5 <= max_seconds and notes:
                notes.append({"phones": ["SP"], "midi": None, "dur": beat * 0.5, "rest": True})
                total += beat * 0.5
            if total >= max_seconds:
                break

        # 去掉结尾多出来的休止
        while notes and notes[-1]["rest"]:
            notes.pop()
        lang = max(lang_counts, key=lang_counts.get) if lang_counts else "zh"
        return notes, "".join(sung_text), lang

    # ---------- DS 段落 ----------

    def build_ds(self, notes, text, lang="zh"):
        ph_seq = []
        ph_num = []
        note_seq = []
        note_dur = []
        for note in notes:
            ph_seq.extend(note["phones"])
            ph_num.append(len(note["phones"]))
            note_seq.append("rest" if note["rest"] else midi_to_name(note["midi"]))
            note_dur.append(round(note["dur"], 4))
        return {
            "offset": 0,
            "text": text,
            "lang": lang,
            "ph_seq": " ".join(ph_seq),
            "ph_num": " ".join(str(n) for n in ph_num),
            "note_seq": " ".join(note_seq),
            "note_slur": " ".join("0" for _ in note_seq),
            "note_dur": " ".join(str(d) for d in note_dur),
        }

    # ---------- 唱 ----------

    def pick_lang(self, lang):
        """声库的语言表里没有这门语言时退回声库默认，免得 diffsinger_utau 里 assert 直接炸。"""
        content = getattr(getattr(self.pred, "dsvariance", None), "languages", None)
        table = getattr(content, "content", None)
        if table and lang not in table:
            return next(iter(table))
        return lang

    def sing(self, job):
        from diffsinger_utau.voice_bank.commons.ds_reader import DSReader

        lyrics = (job.get("lyrics") or "").strip()
        if not lyrics:
            raise ValueError("歌词为空")
        bpm = int(job.get("bpm") or 96)
        key_shift = int(job.get("keyShift") or 0)
        scale = job.get("scale") or "major"
        # seed=0 时按歌词固定：同一首歌每次唱都是同一条旋律（Python 的 str hash 每个进程随机，不能用）。
        seed = int(job.get("seed") or 0) or int(hashlib.sha1(lyrics.encode("utf-8")).hexdigest()[:8], 16)
        max_seconds = float(job.get("maxSeconds") or 60)
        out = Path(job["out"])

        notes, text, lang = self.build_notes(lyrics, bpm, key_shift, scale, seed, max_seconds)
        if not notes:
            raise ValueError(
                "没有可唱的字：中文要汉字且声库音素表里有读音，"
                "日语要假名且声库自带假名词典，英语要声库自带英语词典（dsdur/dsdict-en.yaml）"
            )

        ds = DSReader.DSSection(self.build_ds(notes, text, lang))
        out.parent.mkdir(parents=True, exist_ok=True)
        work = out.parent / f"{out.stem}.work"
        work.mkdir(parents=True, exist_ok=True)

        # 音色：接口/面板给短名（Normal / Soft…），这里换成 dsconfig 里的完整说话人名；
        # 空则由库里自己挑第一个（单音色声库本来就只有默认的那一个）。
        speaker = self.resolve_speaker(job.get("speaker"))

        results = self.pred.predict_full_pipeline(
            ds=ds,
            lang=self.pick_lang(lang),
            speaker=speaker,
            key_shift=0,  # 旋律里已经按 keyShift 生成
            pitch_steps=int(job.get("pitchSteps") or 10),
            variance_steps=int(job.get("varianceSteps") or 10),
            acoustic_steps=int(job.get("acousticSteps") or 20),
            gender=float(job.get("gender") or 0),
            output_dir=str(work),
            save_intermediate=False,
        )
        produced = Path(results["audio_path"])
        if not produced.exists():
            raise RuntimeError(f"声码器没有写出音频：{produced}")
        os.replace(produced, out)
        for leftover in work.glob("*.ds"):
            leftover.unlink(missing_ok=True)
        try:
            work.rmdir()
        except OSError:
            pass
        seconds = len(results["wav"]) / float(self.pred.dsvocoder.sample_rate)
        return {
            "ms": 0,
            "seconds": round(seconds, 3),
            "notes": len(notes),
            "sungChars": len(text),
            "lang": lang,
            "sampleRate": int(self.pred.dsvocoder.sample_rate),
        }


WARMUP_LYRICS = ("啊", "あ", "ah")


def warmup(singer):
    """显卡档第一次建 CUDA session 要付一次性开销（卷积算法与内核加载）。

    载入后先用一句两秒以内的短句跑完整链路，把这段开销挪到引擎启动阶段，
    用户点第一句时就不再等。声库里找不到对应音素就换下一个，全都不行也不影响就绪。
    """
    started = time.time()
    for lyrics in WARMUP_LYRICS:
        work = Path(tempfile.mkdtemp(prefix="singer-warmup-"))
        try:
            singer.sing({
                "lyrics": lyrics, "bpm": 96, "scale": "major",
                "acousticSteps": 10, "maxSeconds": 2, "out": str(work / "warmup.wav"),
            })
            print(f"[singer] 显卡热身完成 {time.time() - started:.1f}s", file=sys.stderr)
            return True
        except Exception as exc:
            print(f"[singer] 热身「{lyrics}」没唱成：{exc}", file=sys.stderr)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return False


def main():
    if len(sys.argv) < 2:
        send({"type": "fatal", "error": "用法：worker.py <声库目录> [auto|cpu|cuda]"})
        return 2
    voicebank = sys.argv[1]
    if not Path(voicebank).is_dir():
        send({"type": "fatal", "error": f"声库目录不存在：{voicebank}"})
        return 2
    requested = sys.argv[2] if len(sys.argv) > 2 else "auto"
    device = prepare_device(requested)

    singer = Singer(voicebank, device)
    try:
        speakers = singer.load()
    except Exception as exc:  # 声库结构不对或缺声码器，直接把原因带回面板
        send({"type": "fatal", "error": f"声库加载失败：{exc}"})
        traceback.print_exc()
        return 1
    # session 建完才知道 CUDA 有没有真的用上（驱动 / cuDNN 问题会在建 session 时退回 CPU）。
    device = singer.device_state.get("device", "cpu")
    if device == "cuda":
        warmup(singer)
    send({
        "type": "ready",
        "voicebank": Path(voicebank).name,
        "sampleRate": singer.sample_rate,
        "speakers": speakers,
        "device": device,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            send({"type": "fatal", "error": f"协议行不是 JSON：{exc}"})
            continue
        op = msg.get("op")
        if op == "shutdown":
            return 0
        if op != "sing":
            send({"type": "result", "id": msg.get("id"), "ok": False, "kind": "param", "error": f"未知 op：{op}"})
            continue
        started = time.time()
        try:
            stats = singer.sing(msg)
            stats["ms"] = int((time.time() - started) * 1000)
            send({"type": "result", "id": msg.get("id"), "ok": True, **stats})
        except Exception as exc:
            traceback.print_exc()
            kind = "param" if isinstance(exc, ValueError) else "infer"
            send({
                "type": "result", "id": msg.get("id"), "ok": False,
                "kind": kind, "error": str(exc) or exc.__class__.__name__,
            })
    return 0


if __name__ == "__main__":
    sys.exit(main())
