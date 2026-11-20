#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
常驻 DiffSinger 推理 worker。

Node 侧（engine.ts）把 JSON 一行写进 stdin，worker 把 JSON 一行写回 stdout；
其余输出（含 diffsinger_utau 自己打印的进度）全部改道 stderr，免得污染协议。

一次 `sing` 的完整链路：
    歌词 → 按标点断句 → 每字/每假名/每词取音素（中文查拼音，日语查声库自带假名词典，
    英语查声库自带英语词典并按音节分音符）
         → 按起承转合生成五声音阶旋律（上行—顶点—下行，句末落主音/三音）
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

# 旋律骨架用「绝对五声级数」表示：0 是主音，每 5 级换一个八度（5、6… 自然跨到高八度）。
# 音域 0…8 级约 1.5 个八度（C4…G5），对上儿歌常见的十度音域。
MELODY_LOW = 0
MELODY_HIGH = 8
# 每句落音只允许主音、三音、五度（含高八度），可以落在高八度：0/5 是主音，2/7 是三音，3/8 是五度。
MELODY_TONIC = 0
MELODY_THIRD = 2
MELODY_TONIC_HIGH = 5
MELODY_CADENCES = (0, 2, 3, 5, 7, 8)
# 句尾拉长、句间气口、句内气口（单位：拍）。句末音长不写死，按本句其余音的平均时长的倍数算，
# 这样换了节奏型的套件（轻快 / 慢板）句尾的相对收束感都一致。
# 声库在每个音的起音处会按音值比例留一段辅音/气声（长音实测 0.5–0.9 s），音值越长越拖；
# 所以节奏型整体收紧到 0.75，句尾倍数也回到 2.1 / 2.3，末音上限 2.4 拍。
# 节奏模式：
#   classic —— 原版 0.1.16 的断句：每字半拍、每句末字一拍、不插任何气口，速度用设定值不浮动；
#   flow    —— 0.1.20 的套件节奏：节奏型 ×0.75、句尾按倍数拉长、句内/句间气口与 ±8% 速度浮动。
# 默认用 classic：用户反馈原版的句子最利落，而旋律仍走下面的起承转合规则（两版逐音音高一致，
# 只换时值），要回到 0.1.20 的呼吸感改这一个常量即可。
RHYTHM_MODE = "classic"
RHYTHM_SCALE = 0.75
PHRASE_TAIL_RATIO = 2.1
FINAL_TAIL_RATIO = 2.3
TAIL_MIN_BEATS = 1.2
TAIL_MAX_BEATS = 2.4
BREATH_BEATS = 0.4
INNER_BREATH_BEATS = 0.12
# 动机家族：全部是手写的通用走法（相对动机起点的五声级数），只描述「上行—顶点—回落」，
# 不取自任何现有歌曲。大调偏明亮，小调偏下行；按句长挑长度最贴近的一条。
MOTIF_FAMILIES = {
    "arch": {  # 拱形：先上到顶点再回落，最像儿歌里的一句话
        "major": ((0, 1, 2, 1), (0, 1, 2, 3, 2), (0, 2, 3, 2, 1)),
        "minor": ((0, 1, 2, 1), (0, 1, 2, 3, 2), (0, 2, 1, 0)),
    },
    "step": {  # 级进：几乎只用相邻音，平稳、口语感强
        "major": ((0, 1, 2, 1), (0, 1, 2, 3, 2), (0, 1, 2, 1, 0), (0, 1, 2, 3, 2, 1)),
        "minor": ((0, 1, 2, 1), (0, 1, 2, 3, 2), (0, 1, 0, 1), (0, 1, 2, 1, 0, 1)),
    },
    "leap": {  # 跳进：三四度起句，活泼
        "major": ((0, 2, 3, 2), (0, 2, 1, 2), (0, 3, 2, 1), (0, 2, 3, 2, 1)),
        "minor": ((0, 2, 3, 2), (0, 2, 1, 0), (0, 3, 1, 2), (0, 3, 2, 1, 0)),
    },
    "wave": {  # 波浪：上上下下，起伏连续
        "major": ((0, 1, 2, 1, 2), (0, 2, 1, 2), (0, 1, 0, 1, 2), (0, 2, 1, 2, 1)),
        "minor": ((0, 1, 2, 1, 2), (0, 2, 1, 2), (0, 1, 2, 1), (0, 2, 1, 2, 1)),
    },
    "hump": {  # 小回环：上去一点就折回，句幅短，童谣感
        "major": ((0, 2, 1, 2), (0, 3, 2, 3), (0, 2, 3, 2), (0, 2, 1, 2, 1)),
        "minor": ((0, 2, 1, 2), (0, 3, 2, 1), (0, 2, 1, 0), (0, 2, 1, 2, 1)),
    },
    "climb": {  # 阶梯上行：一路往上不回头，句尾挂在高处，适合两小句一问一答
        "major": ((0, 1, 2, 4), (0, 2, 3, 4), (0, 1, 3, 4), (0, 1, 2, 3, 4)),
        "minor": ((0, 1, 3, 4), (0, 2, 3, 4), (0, 1, 2, 4), (0, 1, 2, 3, 4)),
    },
    "swing": {  # 摆荡：宽窄交替，起伏落差大，山歌 / 船歌用
        "major": ((0, 2, 1, 3), (0, 1, 3, 2), (0, 2, 4, 2), (0, 2, 3, 1)),
        "minor": ((0, 2, 1, 3), (0, 1, 3, 2), (0, 3, 2, 1), (0, 2, 1, 3, 1)),
    },
    "sigh": {  # 叹息：起音高、顺势落下，叙事 / 抒情
        "major": ((0, 2, 1, 0), (0, 1, 0, 1), (0, 3, 2, 1), (0, 2, 1, 0, 1)),
        "minor": ((0, 2, 1, 0), (0, 1, 0, 1), (0, 3, 2, 1), (0, 2, 1, 0, 1)),
    },
}
# 结构套件：一首歌只挑一套，套内所有句子严格共用（乐句循环长度、动机家族、起音、落音偏好、
# 节奏型、重音间隔、句内气口间隔），不同套之间听感差别明显。每句自己是个小拱形，句子之间靠
# 音区抬高：起低、承中高、转最高、合回落。规则组织方式参考了 music21 的「独立规则 + 统一检查」
# 思路（仅借鉴组织方式，未引用其代码；music21 为 BSD 许可）。
# start：这套的起音级数，直接决定这首歌从哪个音区开口（不再靠抬级+移调去凑）。
# accent / turn_acc：长音每隔几个音落一次；「转」句用更密的 turn_acc，靠节奏再加一层对比。
SCHEMES = (
    {   # 儿歌：四句一轮，动机短、拱形，落三音，节奏轻快
        "name": "儿歌",
        "period": 4,
        "family": "arch",
        "cadence": "open",
        "start": 1,
        "motif_len": (4, 4),
        "rhythm": (0.5, 1.0),
        "accent": 3,
        "turn_acc": 2,
        "breath": (6, 7),
    },
    {   # 进行曲：两句一问一答，级进为主，落主音，节奏方正
        "name": "进行曲",
        "period": 2,
        "family": "step",
        "cadence": "closed",
        "start": 0,
        "motif_len": (5, 6),
        "rhythm": (0.75, 1.25),
        "accent": 4,
        "turn_acc": 2,
        "breath": (7, 8),
    },
    {   # 山歌：三句一轮，跳进起句，落三音，长短悬殊
        "name": "山歌",
        "period": 3,
        "family": "leap",
        "cadence": "open",
        "start": 3,
        "motif_len": (4, 5),
        "rhythm": (0.5, 1.5),
        "accent": 3,
        "turn_acc": 2,
        "breath": (6, 8),
    },
    {   # 摇篮曲：三句一轮，波浪走向，慢而长，收主音
        "name": "摇篮曲",
        "period": 3,
        "family": "wave",
        "cadence": "closed",
        "start": 1,
        "motif_len": (4, 5),
        "rhythm": (1.0, 1.5),
        "accent": 4,
        "turn_acc": 3,
        "breath": (7, 8),
    },
    {   # 童谣：四句一轮，小回环，落三音，节奏最碎
        "name": "童谣",
        "period": 4,
        "family": "hump",
        "cadence": "open",
        "start": 2,
        "motif_len": (4, 4),
        "rhythm": (0.5, 0.75),
        "accent": 3,
        "turn_acc": 2,
        "breath": (6, 8),
    },
    {   # 船歌：两句一轮，阶梯上行，落三音，长音拖得开
        "name": "船歌",
        "period": 2,
        "family": "climb",
        "cadence": "open",
        "start": 4,
        "motif_len": (5, 6),
        "rhythm": (0.75, 1.5),
        "accent": 3,
        "turn_acc": 2,
        "breath": (7, 8),
    },
    {   # 圆舞曲：三句一轮，宽窄交替，收主音，长音每两拍一次
        "name": "圆舞曲",
        "period": 3,
        "family": "swing",
        "cadence": "closed",
        "start": 2,
        "motif_len": (4, 5),
        "rhythm": (0.75, 1.25),
        "accent": 2,
        "turn_acc": 2,
        "breath": (6, 7),
    },
    {   # 叙事：四句一轮，叹息下行，收主音，慢句多
        "name": "叙事",
        "period": 4,
        "family": "sigh",
        "cadence": "closed",
        "start": 0,
        "motif_len": (4, 5),
        "rhythm": (1.0, 2.0),
        "accent": 3,
        "turn_acc": 3,
        "breath": (7, 8),
    },
)
# 乐句角色循环：同一首歌按 period 循环，最后一句永远收束成「合」。
ROLE_CYCLES = {
    2: ("起", "承"),
    3: ("起", "承", "转"),
    4: ("起", "承", "转", "起"),
}


def pentatonic_midi(base, degree, scale_steps):
    """绝对五声级数 → MIDI。级数超过 5 就自然进到高八度，不再受「八度走不到」的老分支限制。"""
    return base + 12 * (degree // len(scale_steps)) + scale_steps[degree % len(scale_steps)]


def clamp_degree(degree):
    return max(MELODY_LOW, min(MELODY_HIGH, degree))


def pick_motif(pool, length_band, rng):
    """同一个动机家族里，挑长度最贴合这套结构的一条（句长分布由结构套件决定）。"""
    low, high = length_band
    target = (low + high) / 2
    fitting = [m for m in pool if low <= len(m) <= high] or list(pool)
    nearest = min(abs(len(m) - target) for m in fitting)
    return rng.choice([m for m in fitting if abs(len(m) - target) == nearest])


def phrase_range(role, motif, start, end_options):
    """一句的音区起点与落音：起=套件起点，承高三级，转高五级，合回落一级。

    起点由结构套件的 `start` 指定，不再靠「抬级 + 移调」临时凑，也不会因为叠加到音域上限
    被 clamp 削成同一个音；落音从 `end_options`（主音 / 三音 / 五度）里挑「最靠近动机尾音、
    又低于顶点」的那个，不再每首死落主音。
    """
    if role == "承":
        base = start + 3
    elif role == "转":
        base = start + 5
    elif role == "合":
        base = start + 1
    else:
        base = start
    base = max(MELODY_LOW, min(base, MELODY_HIGH - max(motif)))
    peak = base + max(motif)
    choices = [degree for degree in end_options if degree < peak]
    if not choices:
        choices = [degree for degree in MELODY_CADENCES if degree < peak] or [MELODY_TONIC]
    end = min(choices, key=lambda degree: abs(degree - (base + motif[-1])))
    return base, end


def tame_leaps(degrees):
    """一次大跳之后接级进：连续两个同方向的「三度以上」跳进，把后一个收成级进（顶点不削）。"""
    out = list(degrees)
    for index in range(2, len(out) - 1):
        before, prev, cur = out[index - 2], out[index - 1], out[index]
        if abs(cur - prev) >= 2 and abs(prev - before) >= 2 and (cur - prev) * (prev - before) > 0:
            nxt = out[index + 1]
            if (cur > prev and cur >= nxt) or (cur < prev and cur <= nxt):
                continue  # 这一音就是顶点/谷底，削平了整句就没起伏
            out[index] = clamp_degree(prev + (1 if cur > prev else -1))
    return out


def polish(degrees, end):
    """收尾清理：落音固定；落音前一级级靠近；全句相邻同音掰开（落音不动）。"""
    out = list(degrees)
    if not out:
        return out
    out[-1] = end
    if len(out) >= 2 and (abs(out[-2] - end) > 2 or out[-2] == end):
        out[-2] = clamp_degree(end + 2 if end + 2 <= MELODY_HIGH else end + 1)
    for index in range(1, len(out) - 1):
        if out[index] == out[index - 1]:
            direction = 1 if out[index + 1] >= out[index] else -1
            if not MELODY_LOW <= out[index] + direction <= MELODY_HIGH:
                direction = -direction
            out[index] += direction
    if len(out) >= 3 and out[-2] == out[-3]:
        out[-2] = clamp_degree(end + 1)
    return out


def descend_degrees(current, end, count, stride=2):
    """从 current 往下走到 end，返回 current 之后的 count 个音：前面能跨 stride 级，最后一步必定级进。"""
    notes = []
    remaining = current - end
    for step in range(count):
        left = count - step
        drop = remaining if left == 1 else min(stride, max(0, remaining - (left - 1)))
        current -= drop
        remaining -= drop
        notes.append(clamp_degree(current))
    return notes


def motif_degrees(motif, count, base, end):
    """用这一句所属的动机铺满整句：动机本体 + 抬一级的模进重复，最后收在落音上。

    句内的重复与模进是固定规则，不随 seed 抖动；换 seed 只换结构套件与音区。
    """
    if count <= 1:
        return [end] * count
    notes = []
    cycle = 0
    while len(notes) < count:
        shift = min(cycle, 2)  # 每次重复抬一级做模进，最多抬两级
        before = len(notes)
        for step in motif:
            if len(notes) >= count:
                break
            value = clamp_degree(base + step + shift)
            if notes and value == notes[-1]:
                continue
            notes.append(value)
        cycle += 1
        if len(notes) == before:  # 顶到音域边界原地打转时，改成逐级下行补满
            while len(notes) < count:
                notes.append(clamp_degree(notes[-1] - 1 if notes[-1] > end else notes[-1] + 1))
    return polish(tame_leaps(notes), end)


def descending_tail(start, end, count, stride=2):
    """从 start 一路下行落到 end，「合」句同头之后的换尾收束。"""
    if count <= 1:
        return [end] * count
    return [start] + descend_degrees(start, end, count - 1, stride)


def turn_variant(motif):
    """「转」句同头换尾：起头照搬（相邻句听得出是同一支曲子），尾段再挑一级，收束前的走法不同。

    真正的落音仍由落音规则决定，这里只动动机尾巴。与前后句的区别主要靠音区（固定冲到最高）
    和更密的节奏（套件里的 turn_acc），这样既有对比，又不把相邻句的轮廓呼应切断。
    """
    if len(motif) < 3:
        return motif
    lift = 1 if motif[-1] < 3 else -1
    return motif[:-1] + (motif[-1] + lift,)


def phrase_rhythm(count, short_beats, long_beats, accent, phase=0):
    """结构套件自带的节奏型：长音每隔 accent 个音落一次，其余短音；句末音另算。

    `phase` 是每首歌自己的重音起点（0…accent-1）：同一套件里长音位置整体挪一格，
    时值分布因此换一首就不同，但「每隔 accent 个音一个长音」这条规则不变。
    """
    if count <= 1:
        return []
    return [long_beats if (index + phase) % accent == 0 else short_beats for index in range(count - 1)]


def phrase_tail(body, ratio):
    """句末音长 = 本句其余音平均时长的 ratio 倍（限幅），轻快与慢板套件的收束感一致。"""
    if not body:
        return TAIL_MIN_BEATS
    mean = sum(body) / len(body)
    return min(TAIL_MAX_BEATS, max(TAIL_MIN_BEATS, mean * ratio))


def tone_bias(chars, degrees, reader, limit=2):
    """按普通话声调给个别音符加半音偏置，压低倒字（T2 该走高、T4 该走低）。

    一句最多动两个音，且只在旋律方向与声调方向相反时动，不动落音。
    """
    offsets = [0] * len(chars)
    if reader is None or len(chars) < 2:
        return offsets
    changed = 0
    for index in range(len(chars) - 1):
        tone = reader(chars[index])
        if tone not in (2, 4):
            continue
        step = degrees[index + 1] - degrees[index]
        if index + 1 >= len(chars) - 1:
            continue  # 落音不许偏置，句末必须落在主音/三音上
        if offsets[index + 1]:
            continue
        if tone == 2 and step < 0:
            offsets[index + 1] = 1   # 阳平该走高：把后面的音抬半音，减小下行的幅度
        elif tone == 4 and step > 0:
            offsets[index + 1] = -1  # 去声该走低：把后面的音压半音
        else:
            continue
        changed += 1
        if changed >= limit:
            break
    return offsets


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
        self._tone_reader = None  # 汉字声调查询器，首次用到时再建

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
            # 没指定音色就显式拿第一个：多音色声库如果传 None，库会自己每次挑，出现一句一个音色。
            names = list(self.pred.available_speakers or [])
            return names[0] if names else None
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

    def tone_reader(self):
        """返回「汉字 → 普通话声调 1..4」的查询函数；取不到就返回 None（跳过声调修正）。

        优先用可选的 pypinyin，其次声库自带的拼音词典；两者都没有也只是不做修正，不影响出声。
        """
        if self._tone_reader is not None:
            return self._tone_reader or None
        reader = self._pypinyin_tone_reader() or self._dict_tone_reader()
        self._tone_reader = reader or False
        return reader

    def _pypinyin_tone_reader(self):
        try:
            from pypinyin import Style, lazy_pinyin
        except Exception:
            return None

        def read(char):
            if not HAN.match(char):
                return None
            text = lazy_pinyin(char, style=Style.TONE3, neutral_tone_with_five=True)[0]
            return int(text[-1]) if text and text[-1] in "1234" else None

        return read

    def _dict_tone_reader(self):
        """声库词典里如果存的是带声调数字的拼音（如 ni3），就直接拿来用。"""
        table = getattr(self.replacer, "opencpop_dict", None)
        if not isinstance(table, dict):
            return None

        def read(char):
            value = table.get(char)
            return int(value[-1]) if isinstance(value, str) and value and value[-1] in "1234" else None

        return read

    def build_notes_from_melody(self, melody, lyrics, bpm, key_shift, max_seconds):
        """按指定旋律铺音符：每个有音高的槽吃掉一个歌词单元（字 / 假名 / 音节），
        休止不吃字，延音已经在 Node 侧并进前一个音。返回 (notes, text, lang)。"""
        beat = 60.0 / max(40, bpm)

        units = []
        lang_counts = {}
        for piece in PHRASE_SPLIT.split(lyrics):
            if not piece:
                continue
            piece_units, lang = self.phrase_units(piece)
            for unit in piece_units:
                units.append(unit)
                lang_counts[lang] = lang_counts.get(lang, 0) + 1

        pitched = [note for note in melody if note.get("midi") is not None]
        if len(units) != len(pitched):
            raise ValueError(
                f"歌词有 {len(units)} 个可唱单元（字 / 假名 / 音节），旋律有 {len(pitched)} 个音；"
                "用「-」把长音延下去、用「.」留休止，让两者对齐"
            )

        notes = []
        sung_text = []
        total = 0.0
        index = 0
        for note in melody:
            dur = float(note.get("beats") or 0) * beat
            if dur <= 0:
                continue
            if total + dur > max_seconds:
                break
            midi = note.get("midi")
            if midi is None:
                notes.append({"phones": ["SP"], "midi": None, "dur": dur, "rest": True})
                total += dur
                continue
            grapheme, phonemes = units[index]
            index += 1
            notes.append({
                "phones": phonemes,
                "midi": int(midi) + int(key_shift),
                "dur": dur,
                "rest": False,
            })
            sung_text.append(grapheme)
            total += dur

        while notes and notes[-1]["rest"]:
            notes.pop()
        lang = max(lang_counts, key=lang_counts.get) if lang_counts else "zh"
        return notes, "".join(sung_text), lang

    def build_notes(self, lyrics, bpm, key_shift, scale, seed, max_seconds):
        """按句生成旋律：先挑一套结构规则，再按这套规则铺动机、定落音、切气口。
        每字/每音节一个音符。返回 (notes, text, lang)。"""
        import random

        beat = 60.0 / max(40, bpm)
        scale_steps = SCALES.get(scale, SCALES["major"])
        rng = random.Random(seed)
        root = 60 + key_shift  # C4 起，移调后仍是同一调式

        phrases = []
        for piece in PHRASE_SPLIT.split(lyrics):
            if not piece:
                continue
            units, lang = self.phrase_units(piece)
            if units:
                phrases.append((units, lang))

        # 结构规则整首只挑一次：乐句循环、动机家族、起音、落音偏好、节奏型、重音与气口间隔
        # 都锁死，同一首内部严格按这套走；不同套之间才拉开听感差别。
        # 用「seed + 歌词」挑套件：同一个 seed 下不同歌词也会换套，同一首歌每次都一样。
        picker = random.Random(f"{seed}:{lyrics}")
        # 抽取顺序与 0.1.20 保持一致（经典节奏下只抽不用），这样换节奏模式时音高逐音不变，
        # 对比时听到的差异只来自时值。
        tempo_jitter = picker.uniform(0.92, 1.08)
        if RHYTHM_MODE == "flow":
            beat = beat / tempo_jitter
        scheme = SCHEMES[picker.randrange(len(SCHEMES))]
        family = MOTIF_FAMILIES.get(scheme["family"], MOTIF_FAMILIES["arch"])
        pool = family.get(scale) or family["major"]
        lead = pick_motif(pool, scheme["motif_len"], picker)
        # 套件之外再由歌词定的自由度：动机整体挪 0–2 级、重音起点挪一格、单句的角色、
        # 整首的落点（主音 / 三音 / 五度）与收束步幅。规则不变，但换一首歌起音、走向、
        # 落点、时值都不同。
        lead = tuple(step + picker.choice((0, 1, 2)) for step in lead)
        # 一半的歌把整套动机倒过来走（镜像）：起音从动机顶点开口、先下探再回升，和另一半
        # 「低起上扬」的歌在走向上直接相反；镜像对整首生效，套件内部仍然一致。
        if picker.random() < 0.5:
            top = max(lead)
            lead = tuple(top - step for step in lead)
        phase = picker.randrange(max(2, scheme["accent"]))
        stride = picker.choice((1, 2))
        start = scheme["start"]
        single_role = picker.choice(("起", "承", "转", "合"))
        closing = picker.choice((MELODY_TONIC, MELODY_THIRD, 3))
        short_beats, long_beats = (value * RHYTHM_SCALE for value in scheme["rhythm"])
        breath_every = rng.randint(*scheme["breath"])
        role_cycle = ROLE_CYCLES.get(scheme["period"], ROLE_CYCLES[4])
        tone = self.tone_reader()

        notes = []
        sung_text = []
        total = 0.0
        # 整首歌只给一个 lang（diffsinger_utau 的五个阶段都吃同一个）：按音符数最多的语言。
        lang_counts = {}
        lead_base = start  # 「起」句的音区，留给「合」句做同头换尾

        for order, (units, lang) in enumerate(phrases):
            lang_counts[lang] = lang_counts.get(lang, 0) + len(units)
            last = order == len(phrases) - 1
            role = "合" if last else role_cycle[order % len(role_cycle)]
            # 只有一句歌词时不再一律当「合」：按 seed 在起 / 承 / 转 / 合 里挑，
            # 选到哪一句就用哪一句的轮廓，整首的落点仍按 closing 收。
            if len(phrases) == 1:
                role = single_role
            motif = turn_variant(lead) if role == "转" else lead
            # 末句的落点从整首选定的主音 / 三音 / 五度里取；中间句按套件的 open / closed。
            end_options = (closing,) if last else ((MELODY_THIRD, 3) if scheme["cadence"] == "open" else (MELODY_TONIC,))
            base, end = phrase_range(role, motif, start, end_options)
            if order == 0:
                lead_base = base
            count = len(units)
            if role == "合" and count >= 4:
                # 合句沿用起句的开头（同头），抬高 1–3 级再一路走回收束音（换尾）。抬高幅度按
                # 剩余音域封顶，不会被 MELODY_HIGH 削平；同头至少留三个音，第三音仍是动机原走向。
                head_len = min(max(3, picker.choice((count // 2, count // 2 + 1, count - 2))), count - 1)
                head_cap = MELODY_HIGH - max(lead[:head_len])
                head_base = max(0, min(head_cap, lead_base + picker.choice((1, 2, 3))))
                head = [head_base + step for step in lead[:head_len]]
                tail_end = end
                if tail_end >= min(head):
                    tail_end = min([d for d in (MELODY_TONIC, MELODY_THIRD, 3) if d < min(head)] or [MELODY_TONIC])
                degrees = head + descending_tail(head[-1], tail_end, count - len(head) + 1, stride)[1:]
                end = tail_end
                degrees = polish(degrees, end)
            else:
                degrees = motif_degrees(motif, count, base, end)
            accent = scheme["turn_acc"] if role == "转" else scheme["accent"]
            if RHYTHM_MODE == "classic":
                # 原版断句：每字半拍、每句末字一拍，没有句内/句间气口。
                durs = [0.5] * (count - 1) + [1.0]
            else:
                body = phrase_rhythm(count, short_beats, long_beats, accent, phase)
                ratio = FINAL_TAIL_RATIO if last else PHRASE_TAIL_RATIO
                durs = body + [phrase_tail(body, ratio)]
            offsets = tone_bias([grapheme for grapheme, _ in units], degrees, tone)

            cut = False
            for index, (grapheme, phonemes) in enumerate(units):
                dur = beat * durs[index]
                if total + dur > max_seconds:
                    cut = True
                    break
                notes.append({
                    "phones": phonemes,
                    "midi": pentatonic_midi(root, degrees[index], scale_steps) + offsets[index],
                    "dur": dur,
                    "rest": False,
                })
                sung_text.append(grapheme)
                total += dur
                # 句内气口：每 4–6 个字换一口气，句尾两个音不切（经典节奏不插气口）。
                if RHYTHM_MODE == "flow" and index < count - 2 and (index + 1) % breath_every == 0:
                    gap = beat * INNER_BREATH_BEATS
                    if total + gap <= max_seconds:
                        notes.append({"phones": ["SP"], "midi": None, "dur": gap, "rest": True})
                        total += gap
            if cut:
                break
            if RHYTHM_MODE == "flow" and total + beat * BREATH_BEATS <= max_seconds:
                notes.append({"phones": ["SP"], "midi": None, "dur": beat * BREATH_BEATS, "rest": True})
                total += beat * BREATH_BEATS

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

        melody = job.get("notes")
        if isinstance(melody, list) and melody:
            notes, text, lang = self.build_notes_from_melody(
                melody, lyrics, bpm, key_shift, max_seconds
            )
        else:
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
            acoustic_steps=int(job.get("acousticSteps") or 40),
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
