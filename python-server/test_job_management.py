"""Tests for job CRUD in stt_engine.py, llm_engine.py.

All tests run without any ML model — only testing job creation, cancellation, and status.
"""

import uuid

import stt_engine
import llm_engine


# ── stt_engine.py ─────────────────────────────────────────────────


def test_stt_create_job():
    job_id = stt_engine.create_stt_job("/tmp/audio.wav", language="en")
    assert uuid.UUID(job_id)
    job = stt_engine.get_stt_job(job_id)
    assert job is not None
    assert job["file_path"] == "/tmp/audio.wav"
    assert job["language"] == "en"
    assert job["state"] == stt_engine.SttJobState.QUEUED


def test_stt_cancel_running():
    job_id = stt_engine.create_stt_job("/tmp/a.wav")
    job = stt_engine.get_stt_job(job_id)
    job["state"] = stt_engine.SttJobState.RUNNING
    assert stt_engine.cancel_stt_job(job_id) is True
    assert job["cancel_flag"] is True


def test_stt_cancel_already_canceled():
    job_id = stt_engine.create_stt_job("/tmp/b.wav")
    job = stt_engine.get_stt_job(job_id)
    job["state"] = stt_engine.SttJobState.CANCELED
    assert stt_engine.cancel_stt_job(job_id) is False


def test_stt_model_status():
    # Without loading a model, should be False
    assert stt_engine.is_model_loaded() is False


# ── llm_engine.py ─────────────────────────────────────────────────


def test_llm_create_translate_job():
    segments = [{"start": 0.0, "end": 5.0, "text": "Hello"}]
    glossary = [{"source": "AI", "target": "인공지능"}]
    job_id = llm_engine.create_translate_job(
        segments=segments,
        source_lang="en",
        target_lang="ko",
        glossary=glossary,
    )
    assert uuid.UUID(job_id)
    job = llm_engine.get_translate_job(job_id)
    assert job is not None
    assert job["segments"] == segments
    assert job["glossary"] == glossary
    assert job["state"] == llm_engine.TranslateJobState.QUEUED


def test_llm_cancel_translate():
    segments = [{"start": 0.0, "end": 5.0, "text": "Hi"}]
    job_id = llm_engine.create_translate_job(segments=segments, source_lang="en", target_lang="ko")
    assert llm_engine.cancel_translate_job(job_id) is True
    job = llm_engine.get_translate_job(job_id)
    assert job["cancel_flag"] is True


def test_llm_model_status():
    assert llm_engine.is_model_loaded() is False
