"""Prompt builder for LLM subtitle translation.

Constructs system and user prompts with glossary injection (as chat turns),
rolling summary, and style presets for segment-by-segment translation.
Glossary entries serve as both term dictionary and few-shot style examples.
"""

import re
from typing import Any

LANG_NAMES = {
    "ko": "Korean", "en": "English", "ja": "Japanese",
    "zh": "Chinese", "es": "Spanish", "fr": "French",
    "de": "German", "auto": "the source language",
}

# Tone presets — one-line instructions keyed by (style_preset, target_lang code).
# Only ko/ja have a speech-level distinction worth instructing; every other
# (style, target) combination behaves exactly like "natural".
TONE_INSTRUCTIONS = {
    ("formal", "ko"): "번역은 존댓말(경어체)로 작성하세요.",
    ("casual", "ko"): "번역은 반말(평어체)로 작성하세요.",
    ("formal", "ja"): "翻訳は敬語（です・ます調）で書いてください。",
    ("casual", "ja"): "翻訳は常体（だ・である調）で書いてください。",
}


def build_system_prompt(
    style_preset: str,
    source_lang: str,
    target_lang: str,
    custom_prompt: str | None = None,
    model_category: str = "instruct",
    media_filename: str | None = None,
    media_context: str | None = None,
    media_type: str | None = None,
) -> str:
    """Build the system prompt.

    Simple "professional translation engine" framing — tool identity
    plus a compact rule set. Kept as a single line (plus the /no_think
    marker) because aligned 9B models empirically follow short, dense
    prompts better than long sectioned ones. Custom preset instructions
    are appended after the base line so they stay close to the recency
    position without drowning the base rules.
    """
    src = LANG_NAMES.get(source_lang, source_lang)
    tgt = LANG_NAMES.get(target_lang, target_lang)
    mt = media_type or "movie"

    parts: list[str] = [
        "You are a professional subtitle translation engine.",
        f"Translate {src} {mt} subtitles to natural spoken {tgt}.",
        "Profanity and slang must be translated faithfully.",
    ]

    # Tone preset (ko/ja only) — single line, per the 9B simplicity rule.
    tone = TONE_INSTRUCTIONS.get((style_preset, target_lang))
    if tone:
        parts.append(tone)

    if custom_prompt and custom_prompt.strip():
        parts.append(custom_prompt.strip())

    # Output rule is always last — recency keeps it effective.
    parts.append("Output only the translation.")

    prompt = " ".join(parts)

    if model_category == "general":
        prompt += "\n/no_think"

    return prompt


def _format_timestamp(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def build_user_prompt(
    segments: list[dict[str, Any]],
    current_index: int,
    context_window: int,
    glossary: list[dict[str, str]],
    translations: dict[int, str] | None = None,
    rolling_summary: str | None = None,
    recent_translations_count: int = 10,
) -> str:
    # Direct translation — no context (9B models perform better without it)
    return segments[current_index].get("text", "")


def build_messages(
    segments: list[dict[str, Any]],
    current_index: int,
    source_lang: str,
    target_lang: str,
    context_window: int = 4,
    style_preset: str = "natural",
    glossary: list[dict[str, str]] | None = None,
    translations: dict[int, str] | None = None,
    custom_prompt: str | None = None,
    model_category: str = "instruct",
    rolling_summary: str | None = None,
    recent_translations_count: int = 10,
    media_filename: str | None = None,
    media_context: str | None = None,
    media_type: str | None = None,
    recent_examples: list[dict[str, str]] | None = None,
) -> list[dict[str, str]]:
    """Build chat messages for a single segment translation.

    Glossary entries are injected as chat turns — they serve as both
    term dictionary (short pairs) and few-shot style examples (sentence pairs).

    `recent_examples` is a dynamic buffer of the last N successful
    translations for this job. Injected AFTER the static glossary so the
    model sees: static anchors first, then scene-local style cues, then
    the segment to translate last (strongest recency signal).
    """
    msgs: list[dict[str, str]] = [
        {
            "role": "system",
            "content": build_system_prompt(
                style_preset, source_lang, target_lang,
                custom_prompt=custom_prompt,
                model_category=model_category,
                media_filename=media_filename,
                media_context=media_context,
                media_type=media_type,
            ),
        },
    ]

    # Inject glossary entries as chat turns (dual role: term dict + few-shot).
    # Entries marked `fallback_only` are skipped here — they only exist to
    # catch LLM echoes in post-processing (see _fix_untranslated) and would
    # only burn context tokens if injected as few-shot.
    for entry in (glossary or []):
        if entry.get("fallback_only", False):
            continue
        src_text = entry.get("source", "")
        tgt_text = entry.get("target", "")
        if src_text and tgt_text:
            msgs.append({"role": "user", "content": src_text})
            msgs.append({"role": "assistant", "content": tgt_text})

    # Inject recent translations as additional chat turns (dynamic few-shot).
    for ex in (recent_examples or []):
        src_text = ex.get("source", "")
        tgt_text = ex.get("target", "")
        if src_text and tgt_text:
            msgs.append({"role": "user", "content": src_text})
            msgs.append({"role": "assistant", "content": tgt_text})

    msgs.append({
        "role": "user",
        "content": build_user_prompt(
            segments, current_index, context_window, glossary or [],
            translations=translations,
            rolling_summary=rolling_summary,
            recent_translations_count=recent_translations_count,
        ),
    })

    return msgs


# ── Rolling summary ──────────────────────────────────────────────

def build_summary_messages(
    segments: list[dict[str, Any]],
    translations: dict[int, str],
    start_index: int,
    end_index: int,
    previous_summary: str | None,
    source_lang: str,
    target_lang: str,
    model_category: str = "instruct",
) -> list[dict[str, str]]:
    """Build messages for generating a rolling scene summary."""
    system = (
        "You are a subtitle analyst. Summarize the subtitle segments below in 2-3 sentences.\n"
        "Focus on: scene setting, character names, emotional tone, key events.\n"
        "If a previous summary exists, update it with new information.\n"
        "Keep total under 100 words. Output ONLY the summary.\n"
    )
    if model_category == "general":
        system += "\n/no_think"

    parts: list[str] = []
    if previous_summary:
        parts.append("[Previous summary]")
        parts.append(previous_summary)
        parts.append("")

    parts.append(f"[New segments {start_index + 1}-{end_index + 1}]")
    for i in range(start_index, min(end_index + 1, len(segments))):
        seg = segments[i]
        ts = _format_timestamp(seg.get("start", 0))
        text = seg.get("text", "")
        trans = translations.get(i, "")
        if trans:
            parts.append(f"[{ts}] {text} → {trans}")
        else:
            parts.append(f"[{ts}] {text}")

    parts.append("")
    parts.append("Write an updated summary incorporating the new segments.")

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(parts)},
    ]


