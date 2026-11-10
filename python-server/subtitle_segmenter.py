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
from typing import Iterable, Sequence

# A cue ends after sentence-final punctuation, before a pause this long, or
# before it would grow past these limits (characters of the cue text).
SENTENCE_END = set(".?!。？！…")
MAX_GAP_S = 0.6
MAX_CUE_S = 7.0
MAX_CHARS = 42
# Chinese and Japanese pack more per character and use no spaces: a
# 42-character line is two lines' worth on screen. Korean is in between:
# full-width syllables, but words are separated by spaces.
MAX_CHARS_CJK = 24
MAX_CHARS_HANGUL = 32


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

    def ends_sentence(i: int) -> bool:
        if spans is None:
            return False
        tail = _cue_text(transcript, spans[i][1], spans[i][1])
        return any(c in SENTENCE_END for c in tail)

    cues: list[Cue] = []
    first = 0
    for i in range(len(words)):
        last_word = i == len(words) - 1
        cut = last_word or ends_sentence(i)
        if not cut:
            nxt = words[i + 1]
            cut = (
                nxt.start - words[i].end >= MAX_GAP_S
                or nxt.end - words[first].start > MAX_CUE_S
                or len(text_of(first, i + 1)) > _limit(text_of(first, i + 1))
            )
        if cut:
            text = text_of(first, i)
            if text:
                cues.append(Cue(words[first].start, words[i].end, text))
            first = i + 1
    return cues


def words_from(items: Iterable, offset: float = 0.0) -> list[Word]:
    """Aligner items (objects with text/start_time/end_time) -> Words, shifted
    from chunk time to file time."""
    return [Word(it.text, offset + float(it.start_time), offset + float(it.end_time)) for it in items]
