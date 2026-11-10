from types import SimpleNamespace

from subtitle_segmenter import MAX_CUE_S, Cue, Word, locate, segment, words_from


def ws(*triples):
    return [Word(t, s, e) for t, s, e in triples]


def test_text_comes_from_the_transcript_with_spaces_and_punctuation():
    words = ws(("Hello", 0.1, 0.4), ("everyone", 0.5, 1.0))
    assert segment("Hello, everyone!", words) == [Cue(0.1, 1.0, "Hello, everyone!")]


def test_sentence_end_starts_a_new_cue():
    words = ws(("Hi", 0.0, 0.3), ("there", 0.3, 0.6), ("How", 0.7, 0.9), ("are", 0.9, 1.0), ("you", 1.0, 1.2))
    assert segment("Hi there. How are you?", words) == [
        Cue(0.0, 0.6, "Hi there."),
        Cue(0.7, 1.2, "How are you?"),
    ]


def test_a_long_pause_splits_a_sentence():
    words = ws(("one", 0.0, 0.3), ("two", 1.0, 1.3))
    assert [c.text for c in segment("one two", words)] == ["one", "two"]


def test_cues_never_run_past_the_duration_limit():
    words = [Word(f"w{i}", i * 0.5, i * 0.5 + 0.45) for i in range(30)]
    cues = segment(" ".join(f"w{i}" for i in range(30)), words)
    assert all(c.end - c.start <= MAX_CUE_S for c in cues)
    assert " ".join(c.text for c in cues) == " ".join(f"w{i}" for i in range(30))


def test_latin_cues_stay_within_42_characters():
    text = "this sentence keeps going with many short words and no punctuation at all"
    words = [Word(w, i * 0.2, i * 0.2 + 0.15) for i, w in enumerate(text.split())]
    cues = segment(text, words)
    assert len(cues) > 1
    assert all(len(c.text) <= 42 for c in cues)
    assert " ".join(c.text for c in cues) == text


def test_korean_eojeol_tokens_keep_spaces():
    words = ws(("오늘", 1.8, 2.04), ("은", 2.04, 2.28), ("로컬", 2.28, 2.68), ("자막", 2.68, 3.08))
    assert segment("오늘은 로컬 자막.", words) == [Cue(1.8, 3.08, "오늘은 로컬 자막.")]


def test_korean_sentences_fit_the_hangul_limit_without_mid_sentence_cuts():
    text = "오늘은 로컬 자막 생성 프로그램을 시험해 보겠습니다."
    words = [Word(w.rstrip("."), i * 0.4, i * 0.4 + 0.35) for i, w in enumerate(text.split())]
    assert [c.text for c in segment(text, words)] == [text]


def test_long_korean_still_splits_at_32_characters():
    text = "회의 녹음이나 강의 영상에 자막을 붙일 때 특히 유용하고 번역까지 한 번에 할 수 있습니다"
    words = [Word(w, i * 0.3, i * 0.3 + 0.25) for i, w in enumerate(text.split())]
    cues = segment(text, words)
    assert len(cues) > 1 and all(len(c.text) <= 32 for c in cues)


def test_japanese_cues_use_the_tighter_cjk_limit():
    text = "日本には約七千の島々があり、その最大は本州で、世界で七番目に大きい島とされています"
    chars = [c for c in text if c not in "、"]
    words = [Word(c, i * 0.15, i * 0.15 + 0.1) for i, c in enumerate(chars)]
    cues = segment(text, words)
    assert len(cues) > 1
    assert all(len(c.text) <= 24 for c in cues)
    assert "".join(c.text for c in cues) == text


def test_tokens_that_do_not_match_fall_back_to_joining():
    words = ws(("hello", 0.0, 0.5), ("world", 0.5, 1.0))
    assert segment("완전히 다른 텍스트", words) == [Cue(0.0, 1.0, "hello world")]


def test_cjk_fallback_joins_without_spaces():
    words = ws(("日", 0.0, 0.1), ("本", 0.1, 0.2))
    assert segment("", words) == [Cue(0.0, 0.2, "日本")]


def test_locate_skips_a_few_dropped_characters():
    assert locate("a-b xyz cd", ws(("ab", 0, 1), ("cd", 1, 2))) == [(0, 3), (8, 10)]


def test_empty_input_gives_no_cues():
    assert segment("anything", []) == []


def test_words_from_shifts_chunk_time_to_file_time():
    items = [SimpleNamespace(text="hi", start_time=0.25, end_time=0.5)]
    assert words_from(items, offset=10.0) == [Word("hi", 10.25, 10.5)]
