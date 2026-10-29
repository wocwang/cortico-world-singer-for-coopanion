#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
常驻 DiffSinger 推理 worker。

Node 侧（engine.ts）把 JSON 一行写进 stdin，worker 把 JSON 一行写回 stdout；
其余输出（含 diffsinger_utau 自己打印的进度）全部改道 stderr，免得污染协议。

一次 `sing` 的完整链路：
    歌词 → 按标点断句 → 每字/每假名取音素（中文查拼音，日语查声库自带假名词典）
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
import sys
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

# 断句：句读与空白都算分隔，其余非汉字/假名一律丢掉。
PHRASE_SPLIT = re.compile(r"[，。！？、；：,.!?;:\s…—~～\[\]【】()（）\"'“”‘’]+")
HAN = re.compile(r"[\u4e00-\u9fff]")
# 假名（平假名 + 片假名）：日语声库按「一拍一个假名」出音符。
KANA = re.compile(r"[\u3041-\u309f\u30a1-\u30ff]")
SMALL_KANA = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")
SOKUON = set("っッ")
LONG_VOWEL = "ー"
# 能重复成长音的音素：日语声库的元音音素大小写都可能有（`a` 与 `I`、`U`、`O`）。
VOWELS = set("aiueoAIUEO")


def kata_to_hira(text):
    """片假名转平假名（U+30A1–U+30F6 平移到 U+3041–U+3096，长音符不动）。"""
    return "".join(chr(ord(ch) - 0x60) if "\u30a1" <= ch <= "\u30f6" else ch for ch in text)


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


def _force_basic_optimization():
    """把 ORT 图优化降到 basic。

    绮萱的声学模型（267 MB）在 onnxruntime 的 extended/all 级别优化时会原生崩溃
    （Windows 访问冲突 0xC0000005，1.19.2 与 1.22.0 都能复现），basic 级别正常。
    diffsinger_utau 自己建 SessionOptions，只能从这里包一层。
    """
    import onnxruntime as ort

    original = ort.InferenceSession

    def session(path_or_bytes, sess_options=None, **kwargs):
        options = sess_options or ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        return original(path_or_bytes, sess_options=options, **kwargs)

    ort.InferenceSession = session


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
    def __init__(self, voicebank_dir):
        self.voicebank_dir = Path(voicebank_dir)
        self.pred = None
        self.replacer = None
        self.phoneme_set = None
        self.ja_dict = {}
        self.ja_dict_path = None
        self.sample_rate = 44100

    def load(self):
        normalize_bank_text(self.voicebank_dir)
        _force_basic_optimization()
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
        """按句生成旋律；每字一个音符，句间插一个 SP 休止。返回 (notes, text)。"""
        import random

        beat = 60.0 / max(40, bpm)
        scale_steps = SCALES.get(scale, SCALES["major"])
        rng = random.Random(seed)
        base = 60 + key_shift  # C4 起，移调后仍是同一调式

        phrases = [p for p in PHRASE_SPLIT.split(lyrics) if p]
        notes = []
        sung_text = []
        total = 0.0

        for phrase in phrases:
            # 声库带假名词典、且这句里出现假名 → 按日语切；否则按汉字逐字查拼音。
            if self.ja_dict_path and KANA.search(phrase):
                units = self.ja_units(phrase)
            else:
                units = [
                    (char, phones)
                    for char, phones in ((c, self.syllable_phonemes(c)) for c in HAN.findall(phrase))
                    if phones
                ]
            if not units:
                continue
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
        return notes, "".join(sung_text)

    # ---------- DS 段落 ----------

    def build_ds(self, notes, text):
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
            "ph_seq": " ".join(ph_seq),
            "ph_num": " ".join(str(n) for n in ph_num),
            "note_seq": " ".join(note_seq),
            "note_slur": " ".join("0" for _ in note_seq),
            "note_dur": " ".join(str(d) for d in note_dur),
        }

    # ---------- 唱 ----------

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

        notes, text = self.build_notes(lyrics, bpm, key_shift, scale, seed, max_seconds)
        if not notes:
            raise ValueError("没有可唱的字：中文要汉字且声库音素表里有读音，日语要假名且声库自带假名词典")

        ds = DSReader.DSSection(self.build_ds(notes, text))
        out.parent.mkdir(parents=True, exist_ok=True)
        work = out.parent / f"{out.stem}.work"
        work.mkdir(parents=True, exist_ok=True)

        # 音色：接口/面板给短名（Normal / Soft…），这里换成 dsconfig 里的完整说话人名；
        # 空则由库里自己挑第一个（单音色声库本来就只有默认的那一个）。
        speaker = self.resolve_speaker(job.get("speaker"))

        results = self.pred.predict_full_pipeline(
            ds=ds,
            lang="zh",
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
            "sampleRate": int(self.pred.dsvocoder.sample_rate),
        }


def main():
    if len(sys.argv) < 2:
        send({"type": "fatal", "error": "用法：worker.py <声库目录>"})
        return 2
    voicebank = sys.argv[1]
    if not Path(voicebank).is_dir():
        send({"type": "fatal", "error": f"声库目录不存在：{voicebank}"})
        return 2

    singer = Singer(voicebank)
    try:
        speakers = singer.load()
    except Exception as exc:  # 声库结构不对或缺声码器，直接把原因带回面板
        send({"type": "fatal", "error": f"声库加载失败：{exc}"})
        traceback.print_exc()
        return 1
    send({
        "type": "ready",
        "voicebank": Path(voicebank).name,
        "sampleRate": singer.sample_rate,
        "speakers": speakers,
        "device": "cpu",
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
