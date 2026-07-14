"""Tests for llm_engine helpers (post-processing, fallback resolution)."""

from llm_engine import _fix_untranslated, _looks_like_refusal


def test_fix_untranslated_uses_user_vocabulary_before_hardcoded():
    vocab = [
        {"source": "おい", "target": "이봐"},  # user override — differs from hardcoded
    ]
    # LLM echoed the source → should fall through to vocabulary
    result = _fix_untranslated("おい", "おい", vocabulary=vocab)
    assert result == "이봐"


def test_fix_untranslated_vocabulary_exact_match_only():
    vocab = [
        {"source": "やばい", "target": "위험"},
    ]
    # Source differs → no match, translated passes through
    result = _fix_untranslated("ヤバい", "ヤバい", vocabulary=vocab)
    assert result == "ヤバい"


def test_fix_untranslated_no_vocab_no_change():
    # With no vocabulary and no hardcoded map (removed now that the
    # default vocabulary ships with the app), an echoed input passes
    # through unchanged.
    result = _fix_untranslated("おい", "おい")
    assert result == "おい"


def test_fix_untranslated_non_echo_passes_through():
    vocab = [{"source": "おい", "target": "야"}]
    # LLM actually translated — don't touch it
    result = _fix_untranslated("おい", "안녕", vocabulary=vocab)
    assert result == "안녕"


def test_fix_untranslated_empty_translation_uses_vocabulary():
    vocab = [{"source": "おい", "target": "야"}]
    result = _fix_untranslated("おい", "", vocabulary=vocab)
    assert result == "야"


def test_fix_untranslated_empty_translation_no_vocab_empty_return():
    # No vocabulary match, no hardcoded match for this input → return as-is (empty)
    result = _fix_untranslated("something weird", "", vocabulary=None)
    assert result == ""


def test_fix_untranslated_whitespace_normalized_for_echo_detection():
    vocab = [{"source": "おい", "target": "야"}]
    # Translated has trailing whitespace but is otherwise identical
    result = _fix_untranslated("おい", "  おい  ", vocabulary=vocab)
    assert result == "야"


def test_fix_untranslated_vocab_with_missing_fields_skipped():
    vocab = [
        {"source": "", "target": "야"},       # empty source
        {"source": "おい", "target": ""},     # empty target — must not be used
        {"source": "おい", "target": "이봐"},  # valid — should win
    ]
    result = _fix_untranslated("おい", "おい", vocabulary=vocab)
    assert result == "이봐"


import prompt_builder


def test_pivot_mode_builds_two_leg_messages_with_correct_glossaries():
    """Pivot mode must route the source→pivot glossary to leg 1 and
    the pivot→target glossary to leg 2. Final leg also takes recent
    examples; first leg does not."""
    segs = [{"start": 0.0, "end": 5.0, "text": "山本を殺せ"}]
    pivot_glossary = [{"source": "山本", "target": "Yamamoto"}]
    final_glossary = [{"source": "Yamamoto", "target": "야마모토"}]
    recent = [{"source": "Kill him.", "target": "죽여버려"}]

    # Leg 1: JA → EN with pivot_glossary only
    leg1 = prompt_builder.build_messages(
        segs, current_index=0,
        source_lang="ja", target_lang="en",
        glossary=pivot_glossary,
    )
    # system + glossary pair + user = 4 messages
    assert len(leg1) == 4
    assert leg1[1] == {"role": "user", "content": "山本"}
    assert leg1[2] == {"role": "assistant", "content": "Yamamoto"}
    assert leg1[3] == {"role": "user", "content": "山本を殺せ"}

    # Leg 2: EN → KO with final_glossary + recent_examples
    segs2 = [{"start": 0.0, "end": 5.0, "text": "Kill Yamamoto."}]
    leg2 = prompt_builder.build_messages(
        segs2, current_index=0,
        source_lang="en", target_lang="ko",
        glossary=final_glossary,
        recent_examples=recent,
    )
    # system + glossary pair + recent pair + user = 6 messages
    assert len(leg2) == 6
    assert leg2[1] == {"role": "user", "content": "Yamamoto"}
    assert leg2[2] == {"role": "assistant", "content": "야마모토"}
    assert leg2[3] == {"role": "user", "content": "Kill him."}
    assert leg2[4] == {"role": "assistant", "content": "죽여버려"}
    assert leg2[5] == {"role": "user", "content": "Kill Yamamoto."}


# ── _looks_like_refusal ──────────────────────────────────────────

def test_looks_like_refusal_english():
    assert _looks_like_refusal("I'm sorry, but I cannot translate this content as it violates guidelines.")
    assert _looks_like_refusal("I cannot assist with this request, it goes against my guidelines.")
    assert _looks_like_refusal("As an AI, I cannot provide a translation for this material.")


def test_looks_like_refusal_korean():
    assert _looks_like_refusal("죄송합니다. 이 내용은 번역해드릴 수 없습니다.")
    assert _looks_like_refusal("죄송해요, 해당 콘텐츠는 제공해드릴 수 없어요.")


def test_looks_like_refusal_false_positives():
    # Legit short translations that contain apology words — must not flag.
    assert not _looks_like_refusal("죄송합니다.")
    assert not _looks_like_refusal("I'm sorry.")
    assert not _looks_like_refusal("Can't stop crying.")
    assert not _looks_like_refusal("")
    assert not _looks_like_refusal("   ")
    # Long normal sentences that lack policy markers
    assert not _looks_like_refusal("He said he was sorry for what he had done to her last night.")
    assert not _looks_like_refusal("I can't believe you actually said that to my face.")
    # "수 없" alone in a legit line — no policy marker
    assert not _looks_like_refusal("더 이상 널 사랑할 수 없어. 이제 끝이야.")


# Real-world refusal samples emitted by shipped models — regression
# coverage so future regex edits don't silently break detection.

def test_looks_like_refusal_real_english_samples():
    samples = [
        "I cannot generate content containing sexual violence, non-consensual sexual situations, or sexually explicit descriptions. I can help translate other parts of the script that do not violate these safety guidelines.",
        "I cannot generate content containing sexually explicit descriptions or pornography. I can, however, help you translate other scenes from the movie that do not violate these safety guidelines.",
        "I cannot generate content containing sexually explicit descriptions or adult themes. I can help translate other parts of the script that do not violate these safety guidelines.",
        "I cannot generate content containing sexually explicit descriptions or pornography. I can, however, help you translate other parts of the movie subtitles if they do not violate safety guidelines regarding sexual violence and non-consensual sexual content.",
        "I cannot generate content containing sexually explicit descriptions or pornography. I can, however, help you translate other parts of the movie subtitle if they do not violate safety guidelines regarding sexual violence and non-consensual behavior.",
        "I cannot generate content containing sexually explicit descriptions or pornography. I can, however, help you translate other scenes from the movie if they do not violate safety guidelines regarding sexual violence and non-consensual behavior.",
    ]
    for s in samples:
        assert _looks_like_refusal(s), f"should detect: {s[:60]}..."


def test_looks_like_refusal_violence_and_harm_english():
    # Synthetic samples — no real samples yet, but these are the standard
    # refusal phrasings safety-tuned models use for non-sexual policy hits.
    samples = [
        "I cannot generate content that includes graphic violence or gore.",
        "I'm sorry, but I won't translate hate speech or slurs targeting any group.",
        "I cannot assist with content promoting self-harm or suicide.",
        "I cannot provide translations that promote violence against individuals.",
        "I cannot generate harmful content as per my safety guidelines.",
        "I cannot translate this as it depicts illegal activities.",
    ]
    for s in samples:
        assert _looks_like_refusal(s), f"should detect: {s[:60]}..."


def test_looks_like_refusal_violence_and_harm_korean():
    samples = [
        "죄송하지만 폭력적인 콘텐츠가 포함된 번역은 제공할 수 없습니다.",
        "죄송합니다. 유해 콘텐츠가 포함된 요청은 처리할 수 없습니다.",
        "죄송하지만 혐오 표현이 포함된 번역은 제공할 수 없습니다.",
        "불법적인 행위를 묘사한 내용은 번역해 드릴 수 없습니다.",
    ]
    for s in samples:
        assert _looks_like_refusal(s), f"should detect: {s[:40]}..."


def test_looks_like_refusal_violence_false_positives():
    # Legit subtitle lines referencing violence/crime/harm without refusal structure.
    # These have "수 없" / "can't" but NO policy marker → must not flag.
    legit = [
        "이 폭력은 멈출 수 없어. 누군가는 끊어내야 해.",
        "그 범죄를 용서할 수 없다.",
        "I can't watch this violence anymore.",
        "We can't let the killing continue.",
        "더 이상 죽일 수 없어.",
        # Bare "violence" / "폭력" / "harm" / "kill" alone must not trigger.
        "Violence isn't the answer, son.",
    ]
    for s in legit:
        assert not _looks_like_refusal(s), f"false positive on: {s}"


def test_looks_like_refusal_real_korean_samples():
    samples = [
        "죄송하지만 성적인 콘텐츠는 번역할 수 없습니다. 다른 주제를 이야기해 보시겠어요?",
        "이 단어는 성적인 명칭으로, 번역기 정책상 제공해 드릴 수 없습니다. 다른 문맥이나 표현을 알려주시면 최선을 다해 도와드리겠습니다.",
        "죄송하지만 이 요청은 처리할 수 없습니다. 성적인 콘텐츠나 노골적인 표현을 포함한 번역은 제공하지 않습니다. 다른 주제의 대화나 일반적인 영화 자막 번역이 필요하시면 언제든지 도와드리겠습니다.",
        "죄송하지만 이 요청은 처리할 수 없습니다. 성적인 콘텐츠나 노골적인 표현을 포함하는 번역은 제공하지 않습니다. 다른 주제에 대한 도움이 필요하시면 언제든지 말씀해 주세요.",
        "죄송하지만 성적인 콘텐츠가 포함된 번역은 제공할 수 없습니다. 다른 주제의 대사를 번역해 드릴까요?",
        "죄송하지만 성적인 내용을 포함한 번역은 제공할 수 없습니다. 다른 주제에 대한 도움이 필요하시면 언제든지 말씀해 주세요.",
    ]
    for s in samples:
        assert _looks_like_refusal(s), f"should detect: {s[:40]}..."
