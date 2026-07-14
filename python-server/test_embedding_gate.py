"""Unit tests for the semantic (embedding) gate — no model download.

The cosine threshold logic and graceful-degradation are tested by mocking
``similarity`` / the load state, so CI never fetches the ~250 MB model.
"""
import os

import pytest

import embedding_gate as eg

_SRC = "足でするのは浮気になりませんよ"
_REAL = "발로 하는 건 바람피우는 게 아니에요"
_REFUSE = "죄송하지만 번역할 수 없습니다."


def _real_gate_ready() -> bool:
    """True only when the embedding runtime AND the on-disk model are present,
    so the real-model test runs locally but is skipped in a bare CI env (and
    never triggers the ~250 MB download)."""
    if os.environ.get("LOCALSUB_DISABLE_EMBED_GATE"):
        return False  # gate force-disabled (e.g. CI) -> the real model can't load
    try:
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
    except ImportError:
        return False
    d = eg._model_dir()
    return all(os.path.exists(os.path.join(d, name)) for name, _sha, _sz in eg._ASSETS)


def test_gate_unavailable_returns_false(monkeypatch):
    # Real path: model not loaded -> similarity() returns None -> not flagged.
    monkeypatch.setattr(eg, "_state", "unavailable")
    assert eg.semantic_mismatch(_SRC, _REFUSE) is False


def test_low_similarity_is_mismatch(monkeypatch):
    monkeypatch.setattr(eg, "similarity", lambda a, b: 0.15)
    assert eg.semantic_mismatch(_SRC, _REFUSE) is True


def test_high_similarity_is_ok(monkeypatch):
    monkeypatch.setattr(eg, "similarity", lambda a, b: 0.80)
    assert eg.semantic_mismatch(_SRC, _REAL) is False


def test_threshold_boundary_not_flagged(monkeypatch):
    # Exactly at the threshold is not "below" -> not a mismatch.
    monkeypatch.setattr(eg, "similarity", lambda a, b: eg.SIMILARITY_THRESHOLD)
    assert eg.semantic_mismatch(_SRC, _REAL) is False


def test_short_text_is_skipped(monkeypatch):
    # Even with a (mocked) low score, short interjections are never judged.
    monkeypatch.setattr(eg, "similarity", lambda a, b: 0.0)
    assert eg.semantic_mismatch("はい", "네") is False


def test_none_similarity_returns_false(monkeypatch):
    monkeypatch.setattr(eg, "similarity", lambda a, b: None)
    assert eg.semantic_mismatch(_SRC, _REFUSE) is False


def test_custom_threshold_arg(monkeypatch):
    monkeypatch.setattr(eg, "similarity", lambda a, b: 0.5)
    assert eg.semantic_mismatch(_SRC, _REAL, threshold=0.6) is True
    assert eg.semantic_mismatch(_SRC, _REAL, threshold=0.4) is False


@pytest.mark.skipif(not _real_gate_ready(), reason="embedding model / onnxruntime not present")
def test_real_model_separates_translation_from_refusal():
    """End-to-end with the actual ONNX model (runs only when it's on disk).
    A genuine translation must score closer to the source than a refusal, and a
    Korean refusal must be flagged as a mismatch."""
    eg._state = None  # force a fresh load from the on-disk model
    try:
        assert eg.is_available()
        sim_real = eg.similarity(_SRC, _REAL)
        sim_refuse = eg.similarity(_SRC, "번역할 수 없습니다.")
        assert sim_real is not None and sim_refuse is not None
        assert sim_real > sim_refuse
        assert eg.semantic_mismatch(_SRC, "번역할 수 없습니다.") is True
    finally:
        eg._state = None
