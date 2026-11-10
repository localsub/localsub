"""Qwen3-ASR backend with fake models: no torch, no GPU, no engine pack."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import stt_backend_qwen as qb
import stt_backends
import stt_engine

SR = qb.SAMPLE_RATE


class FakeAsr:
    """Returns a scripted (language, text) per chunk, in order."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def transcribe(self, audio, language=None):
        self.calls.append((len(audio), language))
        out = []
        for _ in audio:
            lang, text = self.script.pop(0)
            out.append(SimpleNamespace(language=lang, text=text))
        return out


class FakeAligner:
    """One word per space-separated token, 0.3 s each from chunk start."""

    def __init__(self):
        self.languages = []

    def align(self, audio, text, language):
        self.languages.append(list(language))
        res = []
        for t in text:
            items = [SimpleNamespace(text=w.strip(".,!?"), start_time=k * 0.3, end_time=k * 0.3 + 0.25)
                     for k, w in enumerate(t.split())]
            res.append(SimpleNamespace(items=items))
        return res


def backend_with(monkeypatch, script, spans_s):
    """A QwenBackend whose audio has speech chunks at `spans_s` (seconds)."""
    b = qb.QwenBackend()
    b._asr = FakeAsr(script)
    b._aligner = FakeAligner()
    total = max(e for _, e in spans_s) + 1.0
    monkeypatch.setattr(qb, "_decode_audio", lambda p: np.zeros(int(total * SR), dtype=np.float32))
    monkeypatch.setattr(qb, "_speech_spans",
                        lambda a: [{"start": int(s * SR), "end": int(e * SR)} for s, e in spans_s])
    return b


# ── Language rules ─────────────────────────────────────────────────

def test_the_aligner_languages_are_the_eleven_from_its_model_card():
    assert qb.ALIGNER_LANGUAGES == {"zh", "yue", "en", "ko", "ja", "fr", "de", "it", "es", "pt", "ru"}
    assert qb.ALIGNER_LANGUAGES <= set(qb.QWEN_LANGUAGES.values())


def test_a_forced_unsupported_language_is_refused_before_any_work(monkeypatch):
    b = backend_with(monkeypatch, [], [(0, 1)])
    with pytest.raises(qb.LanguageUnsupportedError) as e:
        b.transcribe("x.wav", "th")
    assert str(e.value).startswith("stt_language_unsupported_by_engine: ")
    assert "Thai (th)" in str(e.value) and "Whisper" in str(e.value)
    assert b._asr.calls == []


def test_vote_picks_the_language_with_the_most_speech():
    assert qb.vote_language([("ko", 3.0), ("en", 1.0), ("en", 1.5), ("ko", 0.2)]) == "ko"
    assert qb.vote_language([(None, 5.0)]) is None


# ── Transcription flow ─────────────────────────────────────────────

def test_detected_korean_is_aligned_and_cut_into_cues(monkeypatch):
    b = backend_with(monkeypatch, [("Korean", "안녕하세요 여러분."), ("Korean", "반갑습니다.")], [(1, 3), (4, 6)])
    segs, info = b.transcribe("x.wav", None)
    cues = list(segs)

    assert info.language == "ko"
    assert info.duration == pytest.approx(7.0)
    assert [(round(c.start, 2), round(c.end, 2), c.text) for c in cues] == [
        (1.0, 1.55, "안녕하세요 여러분."),
        (4.0, 4.25, "반갑습니다."),
    ]
    assert b._aligner.languages == [["Korean", "Korean"]]


def test_detected_thai_stops_the_job_with_the_plain_reason(monkeypatch):
    b = backend_with(monkeypatch, [("Thai", "สวัสดี"), ("Thai", "ครับ")], [(0, 1), (2, 3)])
    segs, _ = b.transcribe("x.wav", None)
    with pytest.raises(qb.LanguageUnsupportedError, match="stt_language_unsupported_by_engine"):
        list(segs)
    assert b._aligner.languages == [], "nothing is aligned for a refused language"


def test_language_is_decided_on_enough_speech_not_the_first_chunk(monkeypatch):
    """A short English intro does not decide a Korean video."""
    script = [("English", "Intro")] + [("Korean", "말 입니다")] * 7
    spans = [(0, 1)] + [(2 + 4 * k, 5 + 4 * k) for k in range(7)]  # 1 s English, 21 s Korean
    b = backend_with(monkeypatch, script, spans)
    segs, info = b.transcribe("x.wav", None)
    list(segs)
    assert info.language == "ko"
    # The English line is still timed in English; the rest in Korean.
    flat = [l for batch in b._aligner.languages for l in batch]
    assert flat[0] == "English" and set(flat[1:]) == {"Korean"}


def test_forced_language_is_passed_to_the_model(monkeypatch):
    b = backend_with(monkeypatch, [("Japanese", "こんにちは")], [(0, 1)])
    segs, info = b.transcribe("x.wav", "ja")
    list(segs)
    assert b._asr.calls == [(1, "Japanese")]
    assert info.language == "ja"


def test_silence_yields_nothing(monkeypatch):
    b = backend_with(monkeypatch, [("", ""), ("", "")], [(0, 1), (2, 3)])
    segs, info = b.transcribe("x.wav", None)
    assert list(segs) == []
    assert info.language is None


# ── Loading ────────────────────────────────────────────────────────

def test_qwen_model_dirs_need_config_and_safetensors(tmp_path):
    b = qb.QwenBackend()
    (tmp_path / "ok").mkdir()
    (tmp_path / "ok" / "config.json").write_text("{}")
    (tmp_path / "ok" / "model-00001-of-00002.safetensors").write_bytes(b"")
    (tmp_path / "half").mkdir()
    (tmp_path / "half" / "config.json").write_text("{}")
    assert b.find_model(tmp_path, "ok") == tmp_path / "ok"
    assert b.find_model(tmp_path, "half") is None


def test_unavailable_without_the_engine_pack(monkeypatch):
    monkeypatch.delenv("LOCALSUB_ENGINE_PACKS", raising=False)
    with pytest.raises(RuntimeError, match=r"Qwen3-ASR unavailable \(LOCALSUB_ENGINE_PACKS is not set\)"):
        qb.QwenBackend().check_available()


def test_a_pack_that_fails_to_import_reports_the_real_reason(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALSUB_ENGINE_PACKS", str(tmp_path))
    (tmp_path / "qwen3-asr").mkdir()
    (tmp_path / "qwen3-asr" / ".complete").write_text("h")

    def boom():
        raise OSError("[WinError 126] c10.dll")

    monkeypatch.setattr(qb, "_load_qwen", boom)
    with pytest.raises(RuntimeError, match=r"OSError: \[WinError 126\] c10.dll"):
        qb.QwenBackend().check_available()


def test_load_without_the_aligner_is_a_clear_error():
    with pytest.raises(FileNotFoundError, match="aligner"):
        qb.QwenBackend().load(Path("m"), {})


def test_registry_knows_qwen():
    assert isinstance(stt_backends.create_backend("qwen3-asr"), qb.QwenBackend)


# ── Through stt_engine ─────────────────────────────────────────────

def test_load_model_resolves_the_aligner_by_role(monkeypatch, tmp_path):
    monkeypatch.setenv("MODEL_DIR", str(tmp_path))
    for name in ("qwen-asr", "qwen-aligner"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "config.json").write_text("{}")
        (tmp_path / name / "model.safetensors").write_bytes(b"")
    seen = {}
    monkeypatch.setattr(qb.QwenBackend, "check_available", lambda self: None)
    monkeypatch.setattr(qb.QwenBackend, "load", lambda self, p, aux=None: seen.update(model=p, aux=aux))
    monkeypatch.setattr(stt_engine, "_backend", None)
    monkeypatch.setattr(stt_engine, "_loaded_model_id", None)

    stt_engine.load_model("qwen-asr", "qwen3-asr", {"aligner": "qwen-aligner"})
    assert seen == {"model": tmp_path / "qwen-asr", "aux": {"aligner": tmp_path / "qwen-aligner"}}

    stt_engine.unload_model()
    with pytest.raises(FileNotFoundError, match="aligner model not found: gone"):
        stt_engine.load_model("qwen-asr", "qwen3-asr", {"aligner": "gone"})


def test_a_refused_language_reaches_the_app_as_an_error_event(monkeypatch):
    b = backend_with(monkeypatch, [("Thai", "สวัสดี")], [(0, 1)])
    monkeypatch.setattr(stt_engine, "_backend", b)
    monkeypatch.setattr(stt_engine, "_loaded_model_id", "qwen-asr")
    monkeypatch.setattr(stt_engine, "_loaded_engine", "qwen3-asr")
    monkeypatch.setattr(stt_engine, "_probe_duration", lambda p: None)  # single pass, no ffmpeg
    job = stt_engine.create_stt_job("x.wav", model_id="qwen-asr", engine="qwen3-asr")

    async def run():
        return [e async for e in stt_engine.run_stt(job)]

    events = asyncio.run(run())
    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 1
    assert errors[0]["error"].startswith("stt_language_unsupported_by_engine: ")
    assert not [e for e in events if e["type"] == "done"]
