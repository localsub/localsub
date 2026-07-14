"""Deterministic, model-agnostic quality filters for LLM translation output.

These detect *"this output is not a valid translation"* by structural
properties — script, length, repetition — instead of by matching refusal
phrases. Refusal wording varies every generation and differs per model, so a
phrase list is always incomplete; structural signals do not depend on the exact
words or the model.

Coverage (no extra model needed):
  - off_target_language : output is mostly the wrong script (e.g. an English
                          "I can't translate this" when the target is Korean).
  - has_residual_source_script : source script leaked through (Japanese kana, or
                          a CJK char copied verbatim from the source).
  - length_ratio_anomaly : output is implausibly long vs the source — refusals
                          and disclaimers run long; subtitle lines do not.
  - is_degenerate_repeat : output just repeats the previous line although the
                          source differs (a degenerate generation).
  - collapse_immediate_repeats : pure cleanup of back-to-back phrase repetition.

The irreducible residual a structural filter cannot catch is a short refusal
phrased in the target language (e.g. KO "번역할 수 없습니다") — that needs a
semantic check (cross-lingual embedding similarity), added separately.
"""

import re

# ── Unicode script ranges ──────────────────────────────────────────
_HIRAGANA = "぀-ゟ"
_KATAKANA = "゠-ヿｦ-ﾝ"          # incl. half-width katakana
_HANGUL = "가-힣ᄀ-ᇿ㄰-㆏"
_HAN = "一-鿿㐀-䶿豈-﫿"  # CJK ideographs (+compat)

_KANA_RE = re.compile(f"[{_HIRAGANA}{_KATAKANA}]")
_HANGUL_RE = re.compile(f"[{_HANGUL}]")
_HAN_RE = re.compile(f"[{_HAN}]")
_LATIN_RE = re.compile(r"[A-Za-z]")

# Which script a translation *into* a given language should predominantly use.
# Keyed by the 2-letter prefix of the language code/name the app passes.
_TARGET_SCRIPT_RE = {
    "ko": _HANGUL_RE,
    "ja": re.compile(f"[{_HIRAGANA}{_KATAKANA}{_HAN}]"),
    "zh": _HAN_RE,
    "en": _LATIN_RE,
}


def _lang2(lang: str | None) -> str:
    return (lang or "").strip().lower()[:2]


def has_residual_source_script(original: str, translated: str, target_lang: str) -> bool:
    """True if ``translated`` carries source script that a real translation
    would not: Japanese kana (when the target isn't Japanese), or a CJK
    character copied verbatim from ``original`` (when the target isn't Chinese).

    The "copied from original" gate means we never flag legitimate hanja that
    the model produced on its own — only characters echoed straight from the
    source line.
    """
    t = translated or ""
    tl = _lang2(target_lang)

    # Japanese kana never belongs in a non-Japanese translation.
    if tl != "ja" and _KANA_RE.search(t):
        return True

    # CJK ideographs copied straight from the source line (not for zh target).
    if tl != "zh":
        han_out = set(_HAN_RE.findall(t))
        if han_out and (han_out & set(_HAN_RE.findall(original or ""))):
            return True

    return False


def off_target_language(
    translated: str,
    target_lang: str,
    min_letters: int = 12,
    min_ratio: float = 0.30,
) -> bool:
    """True if a non-trivial output is mostly NOT in the target script.

    Catches refusals/meta-comments that come back in the wrong language (very
    often English) regardless of how they're phrased. Short outputs are never
    judged (``min_letters``), so a legitimately terse line is safe.
    """
    t = (translated or "").strip()
    rx = _TARGET_SCRIPT_RE.get(_lang2(target_lang))
    if rx is None:
        return False  # unknown target script — don't guess

    letters = (
        len(_HANGUL_RE.findall(t))
        + len(_LATIN_RE.findall(t))
        + len(_KANA_RE.findall(t))
        + len(_HAN_RE.findall(t))
    )
    if letters < min_letters:
        return False
    return (len(rx.findall(t)) / letters) < min_ratio


def length_ratio_anomaly(
    original: str,
    translated: str,
    max_ratio: float = 4.0,
    min_abs: int = 60,
) -> bool:
    """True if the output is implausibly long vs the source.

    A short subtitle line that comes back as a paragraph is almost always an
    explanation/disclaimer/refusal, not a translation. Both an absolute floor
    (``min_abs``) and a ratio (``max_ratio``) must be exceeded, so normal
    expansion in translation never trips it.
    """
    o = len((original or "").strip())
    t = len((translated or "").strip())
    if t < min_abs:
        return False
    if o == 0:
        return True
    return (t / o) > max_ratio


def is_degenerate_repeat(
    original: str,
    prev_original: str,
    translated: str,
    prev_translated: str,
) -> bool:
    """True if this output merely repeats the previous translation *even though
    the source line is different* — a degenerate generation.

    When the source line is itself identical to the previous one, an identical
    translation is correct and is NOT flagged.
    """
    t = (translated or "").strip()
    if not t or t != (prev_translated or "").strip():
        return False
    return (original or "").strip() != (prev_original or "").strip()


def classify_bad_translation(original: str, translated: str, target_lang: str) -> str | None:
    """Return a short reason code if ``translated`` is structurally not a valid
    translation of ``original``, else ``None``. Repetition is handled separately
    by the caller since it needs the previous segment.

    Reason codes: ``"empty"``, ``"source_leak"``, ``"off_language"``,
    ``"too_long"``.
    """
    if not (translated or "").strip():
        return "empty"
    if has_residual_source_script(original, translated, target_lang):
        return "source_leak"
    if off_target_language(translated, target_lang):
        return "off_language"
    if length_ratio_anomaly(original, translated):
        return "too_long"
    return None


_WS_RE = re.compile(r"\s+")


def collapse_immediate_repeats(text: str, min_repeats: int = 3) -> str:
    """Collapse a token-run repeated back-to-back to a single occurrence:
    ``"빨리 해 빨리 해 빨리 해" -> "빨리 해"``.

    Pure text cleanup (no inference). Only collapses runs of length
    ``>= min_repeats`` to stay conservative — genuine doubles ("아니 아니")
    are left alone.
    """
    t = (text or "").strip()
    if not t:
        return t
    toks = _WS_RE.split(t)
    n = len(toks)
    if n < min_repeats:
        return t

    # For each possible phrase length, collapse consecutive identical runs.
    for plen in range(1, n // 2 + 1):
        out: list[str] = []
        i = 0
        changed = False
        while i < len(toks):
            phrase = toks[i : i + plen]
            if len(phrase) < plen:
                out.extend(toks[i:])
                break
            run = 1
            while toks[i + run * plen : i + (run + 1) * plen] == phrase:
                run += 1
            if run >= min_repeats:
                out.extend(phrase)
                i += run * plen
                changed = True
            else:
                out.append(toks[i])
                i += 1
        toks = out
        if changed:
            n = len(toks)
    return " ".join(toks)
