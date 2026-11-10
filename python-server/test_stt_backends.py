"""The STT backend seam: engine registry, Whisper backend, and how stt_engine
loads a backend. Everything here runs without faster-whisper or a GPU."""

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import gpu_utils
import stt_backend_whisper
import stt_backends
import stt_engine


@pytest.fixture(autouse=True)
def _no_loaded_model(monkeypatch):
    monkeypatch.setattr(stt_engine, "_backend", None)
    monkeypatch.setattr(stt_engine, "_loaded_model_id", None)
    monkeypatch.setattr(stt_engine, "_loaded_engine", None)


class _FakeWhisperModel:
    created: list[tuple[str, str, str]] = []

    def __init__(self, path, device, compute_type):
        _FakeWhisperModel.created.append((path, device, compute_type))
        self.calls: list[tuple[str, dict]] = []

    def transcribe(self, path, **kw):
        self.calls.append((path, kw))
        return iter([SimpleNamespace(start=0.0, end=1.0, text=" hi ")]), SimpleNamespace(
            duration=1.0, language="en"
        )


@pytest.fixture
def fake_whisper(monkeypatch, tmp_path):
    _FakeWhisperModel.created = []
    monkeypatch.setattr(stt_backend_whisper, "WhisperModel", _FakeWhisperModel)
    monkeypatch.setattr(stt_backend_whisper, "WHISPER_LOAD_ERROR", None)
    monkeypatch.setattr(gpu_utils, "get_stt_device", lambda: ("cuda", "default"))
    monkeypatch.setenv("MODEL_DIR", str(tmp_path))
    for name in ("whisper-small", "whisper-base"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "model.bin").write_bytes(b"")
    return tmp_path


# ── Registry ───────────────────────────────────────────────────────

def test_default_engine_is_faster_whisper():
    backend = stt_backends.create_backend()
    assert isinstance(backend, stt_backend_whisper.WhisperBackend)
    assert backend.engine_id == stt_backends.DEFAULT_ENGINE == "faster-whisper"


def test_unknown_engine_is_rejected():
    with pytest.raises(ValueError, match="Unknown STT engine: nope"):
        stt_backends.create_backend("nope")


# ── Whisper backend ────────────────────────────────────────────────

def test_whisper_model_needs_model_bin(tmp_path):
    backend = stt_backend_whisper.WhisperBackend()
    (tmp_path / "half").mkdir()
    (tmp_path / "half" / "config.json").write_text("{}")
    (tmp_path / "whole").mkdir()
    (tmp_path / "whole" / "model.bin").write_bytes(b"")

    assert backend.find_model(tmp_path, "whole") == tmp_path / "whole"
    assert backend.find_model(tmp_path, "half") is None
    assert backend.find_model(tmp_path, "absent") is None


def test_whisper_transcribe_keeps_the_app_decoding_settings(fake_whisper):
    """The refactor moved these settings; they must not have changed. Each one
    guards a past failure (see TRANSCRIBE_KWARGS)."""
    backend = stt_backend_whisper.WhisperBackend()
    backend.load(fake_whisper / "whisper-small")
    backend.transcribe("a.wav", language="ko")

    path, kw = backend._model.calls[0]
    assert path == "a.wav"
    assert kw == dict(
        language="ko",
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(
            max_speech_duration_s=15,
            min_silence_duration_ms=200,
            speech_pad_ms=300,
            threshold=0.3,
        ),
        condition_on_previous_text=False,
        no_speech_threshold=0.3,
        temperature=0.0,
    )


# ── stt_engine.load_model ──────────────────────────────────────────

def test_load_model_builds_whisper_on_the_stt_device(fake_whisper):
    assert stt_engine.load_model("whisper-small") is True

    assert _FakeWhisperModel.created == [(str(fake_whisper / "whisper-small"), "cuda", "default")]
    assert stt_engine.is_model_loaded()
    assert stt_engine._loaded_model_id == "whisper-small"
    assert stt_engine._loaded_engine == "faster-whisper"


def test_load_model_reuses_the_loaded_model(fake_whisper):
    stt_engine.load_model("whisper-small")
    stt_engine.load_model("whisper-small")
    assert len(_FakeWhisperModel.created) == 1


def test_load_model_switches_models(fake_whisper):
    stt_engine.load_model("whisper-small")
    stt_engine.load_model("whisper-base")
    assert [Path(c[0]).name for c in _FakeWhisperModel.created] == ["whisper-small", "whisper-base"]
    assert stt_engine._loaded_model_id == "whisper-base"


def test_missing_model_is_reported_by_name(fake_whisper):
    with pytest.raises(FileNotFoundError, match="Whisper model not found: whisper-large-v3"):
        stt_engine.load_model("whisper-large-v3")
    assert not stt_engine.is_model_loaded()


def test_runtime_failure_wins_over_missing_model(fake_whisper, monkeypatch):
    """A DLL that failed to load is the real problem; reporting the model as
    missing would send the user to re-download it."""
    monkeypatch.setattr(stt_backend_whisper, "WhisperModel", None)
    monkeypatch.setattr(stt_backend_whisper, "WHISPER_LOAD_ERROR", "OSError: [WinError 126]")

    with pytest.raises(RuntimeError, match=r"faster-whisper unavailable \(OSError: \[WinError 126\]\)"):
        stt_engine.load_model("whisper-large-v3")
    assert not stt_engine.is_model_loaded()


def test_unload_drops_the_backend(fake_whisper):
    stt_engine.load_model("whisper-small")
    backend = stt_engine._backend
    stt_engine.unload_model()

    assert not stt_engine.is_model_loaded()
    assert stt_engine._loaded_model_id is None
    assert backend._model is None


# ── stt_engine.run_stt without a model_id ──────────────────────────

def test_run_stt_picks_an_installed_model_when_none_is_given(fake_whisper, monkeypatch):
    import asyncio

    (fake_whisper / "not-a-model").mkdir()
    loaded: list[tuple[str, str]] = []

    def fake_load(model_id, engine):
        loaded.append((model_id, engine))
        raise RuntimeError("stop here")

    monkeypatch.setattr(stt_engine, "load_model", fake_load)
    job_id = stt_engine.create_stt_job("in.mp4")

    events = asyncio.run(_collect(stt_engine.run_stt(job_id)))

    assert len(loaded) == 1
    model_id, engine = loaded[0]
    assert model_id in ("whisper-small", "whisper-base")
    assert engine == "faster-whisper"
    assert events[0]["message"] == "Loading Whisper model..."
    assert events[-1]["type"] == "error"


async def _collect(gen):
    return [ev async for ev in gen]


# ── Import guard, end to end ───────────────────────────────────────

def test_stt_engine_imports_when_faster_whisper_fails_to_load():
    """test_native_import_guards checks the backend module; this checks that
    the guard still protects stt_engine (and so stt_router) through the new
    indirection."""
    from test_native_import_guards import _FailingFinder

    purge = ("stt_engine", "stt_backends", "stt_backend_whisper", "faster_whisper")
    saved = {n: m for n, m in sys.modules.items() if n.split(".")[0] in purge}
    for n in saved:
        del sys.modules[n]
    finder = _FailingFinder("faster_whisper", OSError("[WinError 126] missing DLL"))
    sys.meta_path.insert(0, finder)
    try:
        engine = importlib.import_module("stt_engine")
        with pytest.raises(RuntimeError, match="WinError 126"):
            engine.create_backend().check_available()
    finally:
        sys.meta_path.remove(finder)
        for n in [n for n in sys.modules if n.split(".")[0] in purge]:
            del sys.modules[n]
        sys.modules.update(saved)
