"""Turn forced-aligner word timings into subtitle cues.

Qwen3-ASR returns plain text per speech chunk and the forced aligner returns
one (text, start, end) per word -- per character for Chinese/Japanese -- with
punctuation stripped. Joining the aligner tokens would lose the spaces and
punctuation, so cue text is cut out of the ASR transcript instead: each token
is matched, in order, to the transcript's letters and digits.

Pure functions: no model, no audio, so every rule is pinned by tests.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Iterable, Iterator, Sequence

# A cue ends after sentence-final punctuation or before a pause this long. A
# sentence too long for one cue (characters of the cue text, or duration) is
# split where it reads best: after a comma, else near its middle.
SENTENCE_END = set(".?!。？！…")
CLAUSE_END = set(",;:，、；：")
MAX_GAP_S = 0.6
MAX_CUE_S = 7.0
# Two 42-character lines: the usual limit for Latin-script subtitles. One
# line per cue cut most English sentences in two ("...a simple tomato" /
# "pasta that...").
MAX_CHARS = 84
# Chinese and Japanese pack more per character and use no spaces: a
# 42-character line is two lines' worth on screen. Korean is in between:
# full-width syllables, but words are separated by spaces.
MAX_CHARS_CJK = 24
MAX_CHARS_HANGUL = 32
# Shorter than this a cue flashes past unread ("Everyone.", "First."): it is
# joined to a neighbour when the two fit in one cue.
MIN_CUE_S = 0.83


@dataclass(frozen=True)
class Word:
    text: str
    start: float
    end: float


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def _is_word_char(c: str) -> bool:
    return unicodedata.category(c)[0] in ("L", "N")


def _is_hangul(c: str) -> bool:
    return 0xAC00 <= ord(c) <= 0xD7AF


def _is_cjk(c: str) -> bool:
    """Scripts written without spaces between words (Chinese, Japanese)."""
    o = ord(c)
    return (
        0x3040 <= o <= 0x30FF  # kana
        or 0x3400 <= o <= 0x9FFF  # CJK ideographs
        or 0xF900 <= o <= 0xFAFF
    )


def _fold(c: str) -> str:
    return unicodedata.normalize("NFKC", c).lower()


def locate(transcript: str, words: Sequence[Word]) -> list[tuple[int, int]] | None:
    """Span [start, end) of each word in `transcript`, or None if the words do
    not match it in order (then the caller falls back to joining tokens)."""
    chars = [(i, _fold(c)) for i, c in enumerate(transcript) if _is_word_char(c)]
    pos = 0
    spans: list[tuple[int, int]] = []
    for w in words:
        wanted = [_fold(c) for c in w.text if _is_word_char(c)]
        if not wanted:
            # Nothing to match; anchor it at the current position.
            at = chars[pos][0] if pos < len(chars) else len(transcript)
            spans.append((at, at))
            continue
        first = last = None
        for ch in wanted:
            # Allow skipping a few transcript characters the aligner dropped.
            skip = 0
            while pos < len(chars) and chars[pos][1] != ch and skip < 3:
                pos += 1
                skip += 1
            if pos >= len(chars) or chars[pos][1] != ch:
                return None
            if first is None:
                first = chars[pos][0]
            last = chars[pos][0]
            pos += 1
        spans.append((first, last + 1))
    return spans


def _cue_text(transcript: str, start: int, end: int) -> str:
    # Take the punctuation that follows the last word (",", ".", "」"...), up
    # to the next space or word character.
    while end < len(transcript) and not transcript[end].isspace() and not _is_word_char(transcript[end]):
        end += 1
    return transcript[start:end].strip()


def _joined(words: Sequence[Word]) -> str:
    out = ""
    for w in words:
        if out and not (_is_cjk(out[-1]) and w.text and _is_cjk(w.text[0])):
            out += " "
        out += w.text
    return out


def _limit(text: str) -> int:
    letters = [c for c in text if _is_word_char(c)]
    if not letters:
        return MAX_CHARS
    if sum(1 for c in letters if _is_cjk(c)) * 2 >= len(letters):
        return MAX_CHARS_CJK
    if sum(1 for c in letters if _is_hangul(c)) * 2 >= len(letters):
        return MAX_CHARS_HANGUL
    return MAX_CHARS


def segment(transcript: str, words: Sequence[Word]) -> list[Cue]:
    """Cues for one speech chunk. Times are those of the words given."""
    words = [w for w in words if w.end >= w.start]
    if not words:
        return []
    spans = locate(transcript, words)

    def text_of(a: int, b: int) -> str:  # words[a..b] inclusive
        if spans is not None:
            return _cue_text(transcript, spans[a][0], spans[b][1])
        return _joined(words[a : b + 1])

    def tail_after(i: int) -> str:
        return "" if spans is None else _cue_text(transcript, spans[i][1], spans[i][1])

    def ends_sentence(i: int) -> bool:
        return any(c in SENTENCE_END for c in tail_after(i))

    def ends_clause(i: int) -> bool:
        return any(c in CLAUSE_END for c in tail_after(i))

    def fits(a: int, b: int) -> bool:
        text = text_of(a, b)
        return len(text) <= _limit(text) and words[b].end - words[a].start <= MAX_CUE_S

    # 1. Sentences: cut after sentence-final punctuation and at long pauses.
    groups: list[tuple[int, int]] = []
    first = 0
    for i in range(len(words)):
        if i == len(words) - 1 or ends_sentence(i) or words[i + 1].start - words[i].end >= MAX_GAP_S:
            groups.append((first, i))
            first = i + 1

    # 2. A sentence that does not fit is split where it reads best, never
    # leaving a one-word tail ("...water to a" / "boil.").
    def split(a: int, b: int) -> list[tuple[int, int]]:
        if a == b or fits(a, b):
            return [(a, b)]
        total = len(text_of(a, b))
        best, best_score = a, None
        for j in range(a, b):  # cut after word j
            left, right = len(text_of(a, j)), len(text_of(j + 1, b))
            score = abs(left - right) / total
            if ends_clause(j):
                score -= 0.35
            if j == a or j + 1 == b:  # a single word on its own
                score += 1.0
            if best_score is None or score < best_score:
                best, best_score = j, score
        return split(a, best) + split(best + 1, b)

    pieces = [p for g in groups for p in split(*g)]

    # 3. Join a cue too short to read to the neighbour it is closest to.
    def too_short(p: tuple[int, int]) -> bool:
        return words[p[1]].end - words[p[0]].start < MIN_CUE_S

    def joinable(p: tuple[int, int], q: tuple[int, int]) -> bool:
        return words[q[0]].start - words[p[1]].end < MAX_GAP_S and fits(p[0], q[1])

    changed = True
    while changed:
        changed = False
        for k, p in enumerate(pieces):
            if not too_short(p):
                continue
            prev = pieces[k - 1] if k > 0 and joinable(pieces[k - 1], p) else None
            nxt = pieces[k + 1] if k + 1 < len(pieces) and joinable(p, pieces[k + 1]) else None
            if prev and (not nxt or words[p[0]].start - words[prev[1]].end <= words[nxt[0]].start - words[p[1]].end):
                pieces[k - 1 : k + 1] = [(prev[0], p[1])]
            elif nxt:
                pieces[k : k + 2] = [(p[0], nxt[1])]
            else:
                continue
            changed = True
            break

    cues: list[Cue] = []
    for a, b in pieces:
        text = text_of(a, b)
        if text:
            cues.append(Cue(words[a].start, words[b].end, text))
    return cues


def _join_text(a: str, b: str) -> str:
    if a and b and _is_cjk(a[-1]) and _is_cjk(b[0]):
        return a + b
    return f"{a} {b}"


def merge_short(cues: Iterable[Cue]) -> Iterator[Cue]:
    """Join a cue too short to read to the next one across speech chunks.

    ``segment`` joins short cues within one chunk; a pause that splits speech
    into chunks ("Good morning." | "Everyone.") left them apart. Streams: holds
    back one cue, so cues still reach the caller as they are made.
    """
    held: Cue | None = None
    for cue in cues:
        if held is not None:
            short = held.end - held.start < MIN_CUE_S or cue.end - cue.start < MIN_CUE_S
            text = _join_text(held.text, cue.text)
            if (
                short
                and cue.start - held.end < MAX_GAP_S
                and cue.end - held.start <= MAX_CUE_S
                and len(text) <= _limit(text)
            ):
                held = Cue(held.start, cue.end, text)
                continue
            yield held
        held = cue
    if held is not None:
        yield held


def words_from(items: Iterable, offset: float = 0.0) -> list[Word]:
    """Aligner items (objects with text/start_time/end_time) -> Words, shifted
    from chunk time to file time."""
    return [Word(it.text, offset + float(it.start_time), offset + float(it.end_time)) for it in items]
