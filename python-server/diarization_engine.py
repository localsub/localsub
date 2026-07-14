"""Speaker diarization engine using ONNX embeddings + clustering.

Singleton model pattern: ONNX model is loaded once and reused across jobs.
"""

import asyncio
import json
import uuid
from enum import Enum
from pathlib import Path
from typing import Any, AsyncGenerator

import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    ort = None  # type: ignore[assignment]

try:
    import soundfile as sf
except ImportError:
    sf = None  # type: ignore[assignment]

try:
    from sklearn.cluster import AgglomerativeClustering
except ImportError:
    AgglomerativeClustering = None  # type: ignore[assignment]


# ── Model singleton ────────────────────────────────────────────────

_session: Any = None
_loaded_model_id: str | None = None


def _resolve_model_dir() -> Path:
    import os
    return Path(os.environ.get("MODEL_DIR", "./models"))


def _find_diarization_model_path(model_id: str) -> Path | None:
    base = _resolve_model_dir() / model_id
    if (base / "model.onnx").exists():
        return base / "model.onnx"
    return None


def load_model(model_id: str) -> bool:
    global _session, _loaded_model_id

    if ort is None:
        raise RuntimeError("onnxruntime is not installed")

    if _session is not None and _loaded_model_id == model_id:
        return True

    model_path = _find_diarization_model_path(model_id)
    if model_path is None:
        raise FileNotFoundError(f"Diarization model not found: {model_id}")

    _session = ort.InferenceSession(str(model_path))
    _loaded_model_id = model_id
    return True


def unload_model() -> None:
    global _session, _loaded_model_id
    _session = None
    _loaded_model_id = None


def is_model_loaded() -> bool:
    return _session is not None


# ── Job management ─────────────────────────────────────────────────

class DiarJobState(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


_diar_jobs: dict[str, dict[str, Any]] = {}


def create_diarization_job(
    file_path: str,
    segments: list[dict[str, Any]],
    model_id: str | None = None,
) -> str:
    job_id = str(uuid.uuid4())
    _diar_jobs[job_id] = {
        "id": job_id,
        "file_path": file_path,
        "segments": segments,
        "model_id": model_id,
        "state": DiarJobState.QUEUED,
        "cancel_flag": False,
    }
    return job_id


def cancel_diarization_job(job_id: str) -> bool:
    job = _diar_jobs.get(job_id)
    if job is None:
        return False
    if job["state"] in (DiarJobState.DONE, DiarJobState.FAILED, DiarJobState.CANCELED):
        return False
    job["cancel_flag"] = True
    return True


def get_diarization_job(job_id: str) -> dict[str, Any] | None:
    return _diar_jobs.get(job_id)


def cleanup_job(job_id: str) -> None:
    job = _diar_jobs.get(job_id)
    if job and job["state"] in (
        DiarJobState.DONE,
        DiarJobState.FAILED,
        DiarJobState.CANCELED,
    ):
        del _diar_jobs[job_id]


def _auto_purge_jobs() -> None:
    if len(_diar_jobs) <= 100:
        return
    terminal = [
        jid
        for jid, j in _diar_jobs.items()
        if j["state"] in (DiarJobState.DONE, DiarJobState.FAILED, DiarJobState.CANCELED)
    ]
    for jid in terminal:
        del _diar_jobs[jid]
        if len(_diar_jobs) <= 100:
            break


# ── Audio helpers ──────────────────────────────────────────────────

def _load_audio_segment(file_path: str, start: float, end: float, target_sr: int = 16000) -> np.ndarray:
    """Load a segment of audio, resampled to target_sr mono."""
    if sf is None:
        raise RuntimeError("soundfile is not installed")

    info = sf.info(file_path)
    sr = info.samplerate
    start_frame = int(start * sr)
    end_frame = int(end * sr)
    frames = end_frame - start_frame

    audio, _ = sf.read(file_path, start=start_frame, frames=frames, dtype="float32", always_2d=True)

    # Mono
    if audio.shape[1] > 1:
        audio = audio.mean(axis=1)
    else:
        audio = audio[:, 0]

    # Simple resample if needed
    if sr != target_sr:
        ratio = target_sr / sr
        new_len = int(len(audio) * ratio)
        indices = np.linspace(0, len(audio) - 1, new_len)
        audio = np.interp(indices, np.arange(len(audio)), audio).astype(np.float32)

    return audio


def _extract_embedding(audio: np.ndarray) -> np.ndarray:
    """Extract speaker embedding from audio using the ONNX model."""
    # Pad or truncate to a fixed length (3 seconds at 16kHz)
    target_len = 16000 * 3
    if len(audio) > target_len:
        audio = audio[:target_len]
    elif len(audio) < target_len:
        audio = np.pad(audio, (0, target_len - len(audio)))

    input_data = audio.reshape(1, -1).astype(np.float32)
    input_name = _session.get_inputs()[0].name
    result = _session.run(None, {input_name: input_data})
    return result[0].flatten()


def _cluster_embeddings(embeddings: list[np.ndarray], n_clusters: int | None = None) -> list[str]:
    """Cluster embeddings and return speaker labels."""
    if AgglomerativeClustering is None:
        raise RuntimeError("scikit-learn is not installed")

    if len(embeddings) == 0:
        return []
    if len(embeddings) == 1:
        return ["SPEAKER_0"]

    X = np.array(embeddings)

    # Auto-determine clusters if not specified (max 10)
    if n_clusters is None:
        n_clusters = min(max(2, len(embeddings) // 5), 10)
    n_clusters = min(n_clusters, len(embeddings))

    clustering = AgglomerativeClustering(n_clusters=n_clusters)
    labels = clustering.fit_predict(X)

    return [f"SPEAKER_{label}" for label in labels]


# ── SSE generator ──────────────────────────────────────────────────

async def run_diarization(job_id: str) -> AsyncGenerator[dict[str, Any], None]:
    """Async generator yielding SSE events during diarization."""
    job = _diar_jobs.get(job_id)
    if job is None:
        yield {"type": "error", "job_id": job_id, "error": "Job not found"}
        return

    job["state"] = DiarJobState.RUNNING

    # Determine model_id
    model_id = job.get("model_id")
    if not model_id:
        model_dir = _resolve_model_dir()
        if model_dir.exists():
            for d in model_dir.iterdir():
                if d.is_dir() and (d / "model.onnx").exists():
                    model_id = d.name
                    break

    if not model_id:
        # No diarization model available — skip gracefully
        yield {
            "type": "done",
            "job_id": job_id,
            "result": json.dumps([]),
        }
        job["state"] = DiarJobState.DONE
        cleanup_job(job_id)
        return

    # Load model if needed
    if not is_model_loaded() or _loaded_model_id != model_id:
        yield {
            "type": "diar_progress",
            "job_id": job_id,
            "progress": 0,
            "message": "Loading diarization model...",
        }
        try:
            await asyncio.get_running_loop().run_in_executor(None, load_model, model_id)
        except Exception as e:
            yield {"type": "error", "job_id": job_id, "error": f"Failed to load model: {e}"}
            job["state"] = DiarJobState.FAILED
            cleanup_job(job_id)
            return

    if job["cancel_flag"]:
        job["state"] = DiarJobState.CANCELED
        yield {"type": "cancelled", "job_id": job_id}
        cleanup_job(job_id)
        return

    yield {
        "type": "diar_progress",
        "job_id": job_id,
        "progress": 0,
        "message": "Starting speaker diarization...",
    }

    try:
        file_path = job["file_path"]
        segments = job["segments"]
        loop = asyncio.get_running_loop()
        total = len(segments)
        all_results: list[dict[str, Any]] = []

        # Extract embeddings
        embeddings: list[np.ndarray] = []
        for i, seg in enumerate(segments):
            if job["cancel_flag"]:
                job["state"] = DiarJobState.CANCELED
                yield {"type": "cancelled", "job_id": job_id}
                return

            audio = await loop.run_in_executor(
                None,
                _load_audio_segment,
                file_path,
                seg["start"],
                seg["end"],
            )
            embedding = await loop.run_in_executor(None, _extract_embedding, audio)
            embeddings.append(embedding)

            progress = min(int(((i + 1) / total) * 80), 79)
            yield {
                "type": "diar_progress",
                "job_id": job_id,
                "progress": progress,
                "message": f"Extracting embeddings... ({i + 1}/{total})",
            }
            await asyncio.sleep(0)

        # Cluster
        yield {
            "type": "diar_progress",
            "job_id": job_id,
            "progress": 80,
            "message": "Clustering speakers...",
        }
        speaker_labels = await loop.run_in_executor(None, _cluster_embeddings, embeddings)

        # Emit results
        for i, label in enumerate(speaker_labels):
            seg_data = {
                "index": segments[i]["index"] if "index" in segments[i] else i,
                "speaker": label,
            }
            all_results.append(seg_data)

            yield {
                "type": "diar_segment",
                "job_id": job_id,
                **seg_data,
            }
            await asyncio.sleep(0)

        job["state"] = DiarJobState.DONE
        yield {
            "type": "done",
            "job_id": job_id,
            "result": json.dumps(all_results),
        }

    except Exception as e:
        job["state"] = DiarJobState.FAILED
        yield {"type": "error", "job_id": job_id, "error": str(e)}
    finally:
        cleanup_job(job_id)
        _auto_purge_jobs()
