"""Tests for the deterministic translation quality filters.

Pure-function tests — no model, no llama_cpp. Cases include real defects
observed in the Cold Fish (ja→ko) run: copied-kanji leak (店长), English
refusals, verbose disclaimers, and cross-segment repetition.
"""

import quality_filters as qf


# ── has_residual_source_script ─────────────────────────────────────

def test_kana_leak_flagged_for_korean_target():
    # Output keeps Japanese kana — always wrong for a KO translation.
    assert qf.has_residual_source_script("いい店ですね", "좋은 店이네요 ですね", "ko") is True


def test_kana_allowed_when_target_is_japanese():
    assert qf.has_residual_source_script("hello", "こんにちは", "ja") is False


def test_copied_kanji_flagged():
    # Real case: 店长 copied from source instead of 점장.
    assert qf.has_residual_source_script("店長 怒るなって", "店长님 화내지 마세요", "ko") is True


def test_korean_only_output_is_clean():
    assert qf.has_residual_source_script("店長 怒るな", "점장님 화내지 마세요", "ko") is False


def test_kanji_not_in_source_is_not_a_leak():
    # Model produced a hanja on its own (not echoed from source) — allowed.
    assert qf.has_residual_source_script("ねこ", "고양이 猫", "ko") is False


def test_copied_kanji_allowed_for_chinese_target():
    assert qf.has_residual_source_script("店長です", "店长", "zh") is False


# ── off_target_language ────────────────────────────────────────────

def test_english_refusal_flagged_for_korean_target():
    txt = "I'm sorry, but I can't translate this explicit content."
    assert qf.off_target_language(txt, "ko") is True


def test_natural_korean_not_flagged():
    assert qf.off_target_language("다리를 만지는 건 간통이 아니야.", "ko") is False


def test_short_output_never_off_language():
    # Below the letter floor — don't judge (could be "OK", a name, etc.).
    assert qf.off_target_language("OK", "ko") is False


def test_korean_with_some_latin_is_fine():
    assert qf.off_target_language("그 AI 모델은 정말 좋아", "ko") is False


def test_unknown_target_language_not_judged():
    assert qf.off_target_language("anything at all here", "fr") is False


# ── length_ratio_anomaly ───────────────────────────────────────────

def test_verbose_disclaimer_flagged():
    original = "やめろ"
    translated = (
        "죄송하지만 이 요청은 폭력적이고 노골적인 내용을 포함하고 있어 "
        "안전 가이드라인에 따라 번역을 제공할 수 없습니다. 양해 부탁드립니다."
    )
    assert qf.length_ratio_anomaly(original, translated) is True


def test_normal_translation_length_ok():
    assert qf.length_ratio_anomaly("経験がプロなんだよ", "경험이 프로 수준이야") is False


def test_short_output_never_too_long():
    assert qf.length_ratio_anomaly("はい", "네, 알겠습니다.") is False


# ── is_degenerate_repeat ───────────────────────────────────────────

def test_repeat_with_different_source_is_degenerate():
    assert qf.is_degenerate_repeat("立て", "早くしろ", "일어서", "일어서") is True


def test_repeat_with_same_source_is_legitimate():
    # Source line genuinely repeats -> identical translation is correct.
    assert qf.is_degenerate_repeat("よっしゃ", "よっしゃ", "좋아", "좋아") is False


def test_distinct_translation_not_repeat():
    assert qf.is_degenerate_repeat("立て", "早くしろ", "일어서", "빨리 해") is False


def test_empty_is_not_repeat():
    assert qf.is_degenerate_repeat("a", "b", "", "") is False


# ── classify_bad_translation ───────────────────────────────────────

def test_classify_orders_and_codes():
    assert qf.classify_bad_translation("x", "", "ko") == "empty"
    assert qf.classify_bad_translation("店長", "店长님", "ko") == "source_leak"
    assert (
        qf.classify_bad_translation("やめろ", "I cannot help with that request here", "ko")
        == "off_language"
    )
    assert qf.classify_bad_translation("はい", "네, 알겠습니다.", "ko") is None


# ── collapse_immediate_repeats ─────────────────────────────────────

def test_collapse_triple_phrase():
    assert qf.collapse_immediate_repeats("빨리 해 빨리 해 빨리 해") == "빨리 해"


def test_collapse_single_token_run():
    assert qf.collapse_immediate_repeats("네 네 네 네") == "네"


def test_double_is_left_alone():
    # Genuine emphasis ("아니 아니") — below the >=3 run threshold.
    assert qf.collapse_immediate_repeats("아니 아니") == "아니 아니"


def test_no_repeat_unchanged():
    s = "다리를 만지는 건 간통이 아니야."
    assert qf.collapse_immediate_repeats(s) == s
