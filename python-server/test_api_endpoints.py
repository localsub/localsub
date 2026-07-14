"""FastAPI endpoint integration tests using httpx TestClient.

Only job creation and cancellation are exercised, never the streaming
endpoints that load models, so no real ML models are needed.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


# ── Health ────────────────────────────────────────────────────────


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


# ── STT endpoints ─────────────────────────────────────────────────


@pytest.fixture
def media_file(tmp_path):
    """A real file on disk — /stt/start rejects paths that do not exist."""
    path = tmp_path / "test.wav"
    path.write_bytes(b"")
    return str(path)


def test_stt_start(media_file):
    r = client.post("/stt/start", json={"file_path": media_file, "language": "en"})
    assert r.status_code == 200
    data = r.json()
    assert "job_id" in data
    assert len(data["job_id"]) > 0


def test_stt_start_rejects_missing_file():
    r = client.post("/stt/start", json={"file_path": "/nonexistent/test.wav"})
    assert r.status_code == 400


def test_stt_cancel_success(media_file):
    # Create a job first, then cancel it
    r = client.post("/stt/start", json={"file_path": media_file})
    job_id = r.json()["job_id"]
    r = client.post(f"/stt/cancel/{job_id}")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"


def test_stt_cancel_fail():
    r = client.post("/stt/cancel/nonexistent-id")
    assert r.status_code == 400


def test_stt_stream_not_found():
    r = client.get("/stt/stream/bad-id")
    assert r.status_code == 404


# ── Translate endpoints ───────────────────────────────────────────


def test_translate_start():
    payload = {
        "segments": [{"start": 0.0, "end": 5.0, "text": "Hello"}],
        "source_lang": "en",
        "target_lang": "ko",
    }
    r = client.post("/translate/start", json=payload)
    assert r.status_code == 200
    data = r.json()
    assert "job_id" in data


def test_translate_cancel():
    payload = {
        "segments": [{"start": 0.0, "end": 5.0, "text": "Hello"}],
        "source_lang": "en",
        "target_lang": "ko",
    }
    r = client.post("/translate/start", json=payload)
    job_id = r.json()["job_id"]
    r = client.post(f"/translate/cancel/{job_id}")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"


# ── Runtime endpoints ─────────────────────────────────────────────


def test_runtime_status_unloaded():
    r = client.get("/runtime/status")
    assert r.status_code == 200
    data = r.json()
    assert data["whisper_status"] == "UNLOADED"
    assert data["llm_status"] == "UNLOADED"


def test_runtime_unload():
    r = client.post("/runtime/unload", json={"model_type": "whisper"})
    assert r.status_code == 200
    assert r.json()["status"] == "UNLOADED"


def test_runtime_load_bad_type():
    # An unknown model_type is a client error, not a server error.
    r = client.post("/runtime/load", json={"model_type": "bad", "model_id": "test"})
    assert r.status_code == 400


@patch("psutil.virtual_memory")
def test_runtime_resources(mock_vmem):
    mock_vmem.return_value = type("vmem", (), {"used": 4 * 1024**2, "total": 16 * 1024**2})()
    r = client.get("/runtime/resources")
    assert r.status_code == 200
    data = r.json()
    assert data["ram_used_mb"] > 0
    assert data["ram_total_mb"] > 0
