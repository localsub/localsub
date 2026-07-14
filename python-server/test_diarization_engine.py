"""Unit tests for diarization_engine.py — job management and clustering logic."""

import json
import pytest
import numpy as np

from diarization_engine import (
    create_diarization_job,
    cancel_diarization_job,
    get_diarization_job,
    cleanup_job,
    DiarJobState,
    _cluster_embeddings,
    _diar_jobs,
)

try:
    from sklearn.cluster import AgglomerativeClustering  # noqa: F401
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False


# ── Fixtures ───────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def clear_jobs():
    """Clear job dict before each test."""
    _diar_jobs.clear()
    yield
    _diar_jobs.clear()


SAMPLE_SEGMENTS = [
    {"index": 0, "start": 0.0, "end": 2.5, "text": "Hello"},
    {"index": 1, "start": 3.0, "end": 5.0, "text": "World"},
]


# ── Job management tests ──────────────────────────────────────────


def test_create_job_returns_id():
    job_id = create_diarization_job("test.wav", SAMPLE_SEGMENTS)
    assert isinstance(job_id, str)
    assert len(job_id) > 0


def test_create_job_stores_state():
    job_id = create_diarization_job("test.wav", SAMPLE_SEGMENTS, model_id="community-1")
    job = get_diarization_job(job_id)
    assert job is not None
    assert job["file_path"] == "test.wav"
    assert job["segments"] == SAMPLE_SEGMENTS
    assert job["model_id"] == "community-1"
    assert job["state"] == DiarJobState.QUEUED
    assert job["cancel_flag"] is False


def test_get_nonexistent_job():
    assert get_diarization_job("nonexistent") is None


def test_cancel_queued_job():
    job_id = create_diarization_job("test.wav", SAMPLE_SEGMENTS)
    assert cancel_diarization_job(job_id) is True
    job = get_diarization_job(job_id)
    assert job["cancel_flag"] is True


def test_cancel_running_job():
    job_id = create_diarization_job("test.wav", SAMPLE_SEGMENTS)
    job = get_diarization_job(job_id)
    job["state"] = DiarJobState.RUNNING
    assert cancel_diarization_job(job_id) is True


def test_cancel_done_job_returns_false():
    job_id = create_diarization_job("test.wav", SAMPLE_SEGMENTS)
    job = get_diarization_job(job_id)
    job["state"] = DiarJobState.DONE
    assert cancel_diarization_job(job_id) is False


def test_cancel_nonexistent_job():
    assert cancel_diarization_job("nonexistent") is False


def test_cleanup_removes_done_job():
    job_id = create_diarization_job("test.wav", SAMPLE_SEGMENTS)
    job = get_diarization_job(job_id)
    job["state"] = DiarJobState.DONE
    cleanup_job(job_id)
    assert get_diarization_job(job_id) is None


def test_cleanup_keeps_running_job():
    job_id = create_diarization_job("test.wav", SAMPLE_SEGMENTS)
    job = get_diarization_job(job_id)
    job["state"] = DiarJobState.RUNNING
    cleanup_job(job_id)
    assert get_diarization_job(job_id) is not None


# ── Clustering tests ──────────────────────────────────────────────

sklearn_required = pytest.mark.skipif(not HAS_SKLEARN, reason="scikit-learn not installed")


@sklearn_required
def test_cluster_empty():
    labels = _cluster_embeddings([])
    assert labels == []


@sklearn_required
def test_cluster_single():
    embedding = np.random.randn(192).astype(np.float32)
    labels = _cluster_embeddings([embedding])
    assert labels == ["SPEAKER_0"]


@sklearn_required
def test_cluster_two_distinct_speakers():
    """Two clearly different embeddings should get different labels."""
    np.random.seed(42)
    emb_a = np.ones(192, dtype=np.float32)
    emb_b = -np.ones(192, dtype=np.float32)
    # 4 segments: 2 from each speaker
    embeddings = [emb_a, emb_b, emb_a.copy(), emb_b.copy()]
    labels = _cluster_embeddings(embeddings, n_clusters=2)
    assert len(labels) == 4
    # Same-speaker segments should get the same label
    assert labels[0] == labels[2], "Segments from same speaker should share label"
    assert labels[1] == labels[3], "Segments from same speaker should share label"
    assert labels[0] != labels[1], "Different speakers should have different labels"


@sklearn_required
def test_cluster_label_format():
    """All labels should match SPEAKER_N pattern."""
    np.random.seed(0)
    embeddings = [np.random.randn(192).astype(np.float32) for _ in range(10)]
    labels = _cluster_embeddings(embeddings)
    assert len(labels) == 10
    for label in labels:
        assert label.startswith("SPEAKER_"), f"Label '{label}' doesn't match expected pattern"


@sklearn_required
def test_cluster_n_clusters_capped():
    """n_clusters should be capped at len(embeddings)."""
    embeddings = [np.random.randn(192).astype(np.float32) for _ in range(3)]
    # Request more clusters than samples
    labels = _cluster_embeddings(embeddings, n_clusters=10)
    assert len(labels) == 3
