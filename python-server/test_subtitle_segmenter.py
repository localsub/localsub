from types import SimpleNamespace

from subtitle_segmenter import MAX_CHARS, MAX_CUE_S, MIN_CUE_S, Cue, Word, locate, merge_short, segment, words_from


def ws(*triples):
    return [Word(t, s, e) for t, s, e in triples]


def test_text_comes_from_the_transcript_with_spaces_and_punctuation():
    words = ws(("Hello", 0.1, 0.4), ("everyone", 0.5, 1.0))
    assert segment("Hello, everyone!", words) == [Cue(0.1, 1.0, "Hello, everyone!")]


def test_sentence_end_starts_a_new_cue():
    words = ws(("Hi", 0.0, 0.5), ("there", 0.5, 1.0), ("How", 1.1, 1.5), ("are", 1.5, 1.8), ("you", 1.8, 2.2))
    assert segment("Hi there. How are you?", words) == [
        Cue(0.0, 1.0, "Hi there."),
        Cue(1.1, 2.2, "How are you?"),
    ]


def test_a_long_pause_splits_a_sentence():
    words = ws(("one", 0.0, 0.3), ("two", 1.0, 1.3))
    assert [c.text for c in segment("one two", words)] == ["one", "two"]


def test_cues_never_run_past_the_duration_limit():
    words = [Word(f"w{i}", i * 0.5, i * 0.5 + 0.45) for i in range(30)]
    cues = segment(" ".join(f"w{i}" for i in range(30)), words)
    assert all(c.end - c.start <= MAX_CUE_S for c in cues)
    assert " ".join(c.text for c in cues) == " ".join(f"w{i}" for i in range(30))


def test_latin_cues_stay_within_two_lines():
    text = ("this sentence keeps going with many short words and no punctuation at all "
            "and then it goes on for a while longer than any two lines of a subtitle can hold")
    words = [Word(w, i * 0.2, i * 0.2 + 0.15) for i, w in enumerate(text.split())]
    cues = segment(text, words)
    assert len(cues) > 1
    assert all(len(c.text) <= MAX_CHARS == 84 for c in cues)
    assert " ".join(c.text for c in cues) == text


def test_a_two_line_sentence_stays_one_cue():
    # From a real run: one 42-char line per cue cut this after "tomato".
    text = "Today we are going to make a simple tomato pasta that takes about 20 minutes."
    words = [Word(w.strip("."), i * 0.3, i * 0.3 + 0.25) for i, w in enumerate(text.split())]
    assert [c.text for c in segment(text, words)] == [text]


def test_a_long_sentence_never_leaves_a_one_word_tail():
    text = ("While the water heats up in the pot on the stove, slice two cloves of garlic, "
            "one small onion and a handful of fresh basil leaves for the sauce to a boil")
    words = [Word(w.strip(","), i * 0.2, i * 0.2 + 0.15) for i, w in enumerate(text.split())]
    cues = segment(text, words)
    assert len(cues) > 1
    assert all(len(c.text.split()) > 1 for c in cues)
    assert " ".join(c.text for c in cues) == text


def test_a_long_sentence_is_split_after_a_comma():
    text = ("When the pasta is almost done and the sauce has thickened nicely in the pan, "
            "save a cup of the cooking water before you drain it")
    words = [Word(w.strip(","), i * 0.2, i * 0.2 + 0.15) for i, w in enumerate(text.split())]
    cues = segment(text, words)
    assert cues[0].text.endswith("pan,")


def test_a_cue_too_short_to_read_joins_its_neighbour():
    # "Good morning. Everyone." came out as two 0.6 s flashes.
    words = ws(("Good", 0.08, 0.4), ("morning", 0.4, 0.72), ("Everyone", 1.1, 1.74),
               ("And", 2.06, 2.3), ("welcome", 2.3, 2.8), ("to", 2.8, 2.9), ("the", 2.9, 3.0),
               ("show", 3.0, 3.8))
    cues = segment("Good morning. Everyone. And welcome to the show.", words)
    assert [c.text for c in cues] == ["Good morning. Everyone.", "And welcome to the show."]
    assert all(c.end - c.start >= MIN_CUE_S for c in cues)


def test_a_short_cue_stays_alone_after_a_long_pause():
    words = ws(("Yes", 0.0, 0.4), ("Then", 2.0, 2.5), ("we", 2.5, 2.7), ("go", 2.7, 3.2))
    assert [c.text for c in segment("Yes. Then we go.", words)] == ["Yes.", "Then we go."]


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


# ── merge_short: across speech chunks ──────────────────────────────

def test_short_cues_from_separate_chunks_are_joined():
    # From a real run: each line came from its own speech chunk.
    cues = [Cue(0.08, 0.72, "Good morning."), Cue(1.104, 1.744, "Everyone."),
            Cue(2.064, 3.824, "And welcome to the weekly cooking show.")]
    assert list(merge_short(cues)) == [
        Cue(0.08, 1.744, "Good morning. Everyone."),
        Cue(2.064, 3.824, "And welcome to the weekly cooking show."),
    ]


def test_a_short_cue_joins_the_next_one():
    cues = [Cue(9.828, 10.308, "First."), Cue(10.704, 13.264, "Bring a large pot of salted water to a boil.")]
    assert [c.text for c in merge_short(cues)] == ["First. Bring a large pot of salted water to a boil."]


def test_merge_short_respects_pauses_and_limits():
    assert len(list(merge_short([Cue(0.0, 0.5, "Yes."), Cue(2.0, 4.0, "Then we go.")]))) == 2
    long = "x" * 80
    assert len(list(merge_short([Cue(0.0, 0.5, "Yes."), Cue(0.6, 3.0, long)]))) == 2
    assert len(list(merge_short([Cue(0.0, 0.5, "Yes."), Cue(0.6, 7.2, "a b c")]))) == 2


def test_merge_short_joins_cjk_without_a_space():
    assert [c.text for c in merge_short([Cue(0, 0.4, "はい"), Cue(0.5, 1.5, "そうです")])] == ["はいそうです"]


def test_merge_short_passes_everything_else_through():
    cues = [Cue(0, 2, "one two"), Cue(2.1, 4, "three four")]
    assert list(merge_short(cues)) == cues
    assert list(merge_short([])) == []
