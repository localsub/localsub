"""STT engine backed by faster-whisper.

Singleton model pattern: model is loaded once and reused across jobs.
"""

import asyncio
import json
import logging
import math
import os
import re
import subprocess
import tempfile
import uuid
from enum import Enum
from pathlib import Path
from typing import Any, AsyncGenerator

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None  # type: ignore[misc,assignment]

import gpu_utils

log = logging.getLogger(__name__)

# ── Long-file chunking ───────────────────────────────────────────
# Belt-and-braces guard for the CT2 native crash chased in c0d7b92 / da27d1e.
# int8-stored models (Kotoba-Whisper v2) died inside faster-whisper's
# temperature-retry path on Windows: reported on a 2.5 h video, the first
# temperature=0.0 pass completed, compression ratio 2.78 exceeded the 2.40
# threshold, and the server died mid-retry with no Python exception.
#
# The root causes are fixed — compute_type="default" (c0d7b92) so CT2 never
# dequantizes int8→fp16 at inference, and temperature=0.0 only (da27d1e) so the
# retry ladder is never climbed. Length was the trigger, not the cause: longer
# audio simply gives the decoder more chances to hit a suspicious segment.
#
# Chunking stays as the outer guard. Each 30-min range gets a fresh CT2 decoder
# state, so any such path that survives the two fixes is bounded to one slice.
# Above LONG_FILE_THRESHOLD_S we split into CHUNK_DURATION_S slices and feed
# them one at a time; both fixes above stay in effect per-chunk.
LONG_FILE_THRESHOLD_S = 60 * 60   # 3600s — single-pass for ≤60 min
CHUNK_DURATION_S = 30 * 60        # 1800s — 30-min chunks when splitting


def _compute_chunks(
    duration: float | None,
) -> list[tuple[float | None, float | None, float, float]]:
    """Return a list of (start, end, progress_base_pct, progress_span_pct).

    - duration=None → single (None, None, 0, 100) — caller transcribes the
      whole file without ffmpeg slicing. Only reachable when *both* probes
      failed (ffprobe and the ffmpeg-banner fallback), e.g. an unreadable file.
    - duration ≤ LONG_FILE_THRESHOLD_S → single (0, duration, 0, 100).
    - Otherwise split into CHUNK_DURATION_S slices; the last slice may be
      shorter than CHUNK_DURATION_S.

    Used by the orchestrator so the slicing decision is trivially unit
    testable and the generator body doesn't need to re-derive it.
    """
    if duration is None:
        return [(None, None, 0.0, 100.0)]
    if duration <= LONG_FILE_THRESHOLD_S:
        return [(0.0, float(duration), 0.0, 100.0)]

    chunks: list[tuple[float | None, float | None, float, float]] = []
    num_chunks = math.ceil(duration / CHUNK_DURATION_S)
    for i in range(num_chunks):
        start = float(i * CHUNK_DURATION_S)
        end = float(min((i + 1) * CHUNK_DURATION_S, duration))
        base = (start / duration) * 100.0
        span = ((end - start) / duration) * 100.0
        chunks.append((start, end, base, span))
    return chunks

# ── Model singleton ────────────────────────────────────────────────

_model: Any = None
_loaded_model_id: str | None = None


def _resolve_model_dir() -> Path:
    return Path(os.environ.get("MODEL_DIR", "./models"))


def _find_whisper_model_path(model_id: str) -> Path | None:
    """Return the directory containing model.bin for the given model_id."""
    base = _resolve_model_dir() / model_id
    if (base / "model.bin").exists():
        return base
    return None


def load_model(model_id: str) -> bool:
    global _model, _loaded_model_id

    if _model is not None and _loaded_model_id == model_id:
        return True  # already loaded

    # Unload previous model first
    unload_model()

    if WhisperModel is None:
        raise RuntimeError("faster-whisper is not installed")

    model_path = _find_whisper_model_path(model_id)
    if model_path is None:
        raise FileNotFoundError(f"Whisper model not found: {model_id}")

    device, compute_type = gpu_utils.get_stt_device()
    _model = WhisperModel(
        str(model_path),
        device=device,
        compute_type=compute_type,
    )
    _loaded_model_id = model_id
    log.info("Loaded Whisper model: %s (device=%s)", model_id, device)
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            log.info("[STT] VRAM after load: %.0f/%.0f MB free", free / 1024 / 1024, total / 1024 / 1024)
    except ImportError:
        pass
    return True


def _find_ffmpeg() -> str:
    """Find ffmpeg: check app-local bin first, then system PATH."""
    # Check app-local path
    appdata = os.environ.get("APPDATA", "")
    local_ffmpeg = os.path.join(appdata, "LocalSub", "bin", "ffmpeg.exe")
    if os.path.isfile(local_ffmpeg):
        return local_ffmpeg
    return "ffmpeg"


def _find_ffprobe() -> str:
    """Locate ffprobe — mirrors _find_ffmpeg.

    The app installs it next to ffmpeg.exe: `commands_ffmpeg.rs` extracts every
    entry of `integrity.json`'s `exe_suffixes`. When it is absent,
    `_probe_duration` returns None and the long-file chunking below never runs.
    """
    appdata = os.environ.get("APPDATA", "")
    local_ffprobe = os.path.join(appdata, "LocalSub", "bin", "ffprobe.exe")
    if os.path.isfile(local_ffprobe):
        return local_ffprobe
    return "ffprobe"


_FFMPEG_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")


def _parse_ffmpeg_duration(stderr: str) -> float | None:
    """Pull `Duration: HH:MM:SS.ss` out of an `ffmpeg -i` banner.

    Returns None when the banner says `Duration: N/A` or has no such line.
    """
    m = _FFMPEG_DURATION_RE.search(stderr)
    if not m:
        return None
    hours, minutes, seconds = m.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _duration_via_ffprobe(file_path: str) -> float | None:
    try:
        result = subprocess.run(
            [
                _find_ffprobe(),
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            capture_output=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        return float(result.stdout.decode("utf-8", errors="replace").strip())
    except (ValueError, AttributeError):
        return None


def _duration_via_ffmpeg(file_path: str) -> float | None:
    """Fallback probe: read the duration off `ffmpeg -i`'s banner.

    `ffmpeg -i <file>` with no output file always exits non-zero ("At least one
    output file must be specified"), so the exit code is ignored and stderr is
    parsed instead.
    """
    try:
        result = subprocess.run(
            [_find_ffmpeg(), "-hide_banner", "-i", file_path],
            capture_output=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    return _parse_ffmpeg_duration(result.stderr.decode("utf-8", errors="replace"))


def _probe_duration(file_path: str) -> float | None:
    """Return media duration in seconds, or None on any failure.

    Used by the STT chunking logic to decide whether to split a long file.
    Probe failure falls through to the single-pass path, so we never want this
    to raise — but that fallback silently disables chunking, which is why
    ffprobe failure is backed by an ffmpeg-banner probe rather than giving up.
    """
    duration = _duration_via_ffprobe(file_path)
    if duration is not None:
        return duration
    log.warning("[STT] ffprobe unavailable or failed; falling back to ffmpeg -i")
    duration = _duration_via_ffmpeg(file_path)
    if duration is None:
        # Do not let this pass quietly. The caller falls through to single-pass,
        # which for a >60 min file means no chunking at all — and the transcript
        # comes out looking plausible, so nobody reports it.
        log.error(
            "[STT] Could not determine the duration of %s: neither ffprobe nor "
            "ffmpeg answered. CHUNKING IS DISABLED for this job — a file over "
            "60 minutes will be transcribed in a single pass. Install ffmpeg "
            "(it ships ffprobe) to restore chunking.",
            file_path,
        )
    return duration


def unload_model() -> None:
    global _model, _loaded_model_id
    log.info("[STT] Unloading model: %s", _loaded_model_id)
    if _model is not None:
        del _model
    _model = None
    _loaded_model_id = None
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            vram_free = torch.cuda.mem_get_info()[0] / (1024 * 1024)
            log.info("[STT] CUDA cache cleared, VRAM free: %.0f MB", vram_free)
    except ImportError:
        pass


def is_model_loaded() -> bool:
    return _model is not None


# ── Job management ─────────────────────────────────────────────────

class SttJobState(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


_stt_jobs: dict[str, dict[str, Any]] = {}


def create_stt_job(
    file_path: str,
    language: str | None = None,
    model_id: str | None = None,
    start_time: float | None = None,
    end_time: float | None = None,
) -> str:
    job_id = str(uuid.uuid4())
    _stt_jobs[job_id] = {
        "id": job_id,
        "file_path": file_path,
        "language": language,
        "model_id": model_id,
        "start_time": start_time,
        "end_time": end_time,
        "state": SttJobState.QUEUED,
        "cancel_flag": False,
    }
    return job_id


def cancel_stt_job(job_id: str) -> bool:
    job = _stt_jobs.get(job_id)
    if job is None:
        return False
    if job["state"] in (SttJobState.DONE, SttJobState.FAILED, SttJobState.CANCELED):
        return False
    job["cancel_flag"] = True
    return True


def get_stt_job(job_id: str) -> dict[str, Any] | None:
    return _stt_jobs.get(job_id)


def cleanup_job(job_id: str) -> None:
    """Remove a terminal-state job from memory."""
    job = _stt_jobs.get(job_id)
    if job and job["state"] in (
        SttJobState.DONE,
        SttJobState.FAILED,
        SttJobState.CANCELED,
    ):
        del _stt_jobs[job_id]


def _auto_purge_jobs() -> None:
    """Auto-purge oldest completed jobs when dict exceeds 100 entries."""
    if len(_stt_jobs) <= 100:
        return
    terminal = [
        jid
        for jid, j in _stt_jobs.items()
        if j["state"] in (SttJobState.DONE, SttJobState.FAILED, SttJobState.CANCELED)
    ]
    for jid in terminal:
        del _stt_jobs[jid]
        if len(_stt_jobs) <= 100:
            break


# ── SSE generator ──────────────────────────────────────────────────

async def run_stt(job_id: str) -> AsyncGenerator[dict[str, Any], None]:
    """Async generator yielding SSE events during transcription."""
    job = _stt_jobs.get(job_id)
    if job is None:
        yield {"type": "error", "job_id": job_id, "error": "Job not found"}
        return

    job["state"] = SttJobState.RUNNING

    # Determine model_id — fallback to first available model
    model_id = job.get("model_id")
    if not model_id:
        model_dir = _resolve_model_dir()
        if model_dir.exists():
            for d in model_dir.iterdir():
                if d.is_dir() and (d / "model.bin").exists():
                    model_id = d.name
                    break
    if not model_id:
        yield {"type": "error", "job_id": job_id, "error": "No STT model available"}
        job["state"] = SttJobState.FAILED
        cleanup_job(job_id)
        return

    # Load model if needed
    if not is_model_loaded() or _loaded_model_id != model_id:
        yield {
            "type": "stt_progress",
            "job_id": job_id,
            "progress": 0,
            "message": "Loading Whisper model...",
        }
        try:
            await asyncio.get_running_loop().run_in_executor(None, load_model, model_id)
        except Exception as e:
            yield {"type": "error", "job_id": job_id, "error": f"Failed to load model: {e}"}
            job["state"] = SttJobState.FAILED
            cleanup_job(job_id)
            return

    if job["cancel_flag"]:
        job["state"] = SttJobState.CANCELED
        yield {"type": "cancelled", "job_id": job_id}
        cleanup_job(job_id)
        return

    yield {
        "type": "stt_progress",
        "job_id": job_id,
        "progress": 0,
        "message": "Starting transcription...",
    }

    try:
        async for event in _run_whisper(job_id, job):
            yield event
    except Exception as e:
        job["state"] = SttJobState.FAILED
        yield {"type": "error", "job_id": job_id, "error": str(e)}
    finally:
        cleanup_job(job_id)
        _auto_purge_jobs()


async def _transcribe_range(
    job_id: str,
    job: dict,
    source_file: str,
    language_arg: str | None,
    range_start: float | None,
    range_end: float | None,
    time_offset: float,
    progress_base: float,
    progress_span: float,
    index_base: int,
    duration_hint: float,
) -> AsyncGenerator[dict[str, Any], None]:
    """Run a single faster-whisper transcription pass, optionally on a
    time slice of `source_file`.

    Yields stt_segment + stt_progress events exactly like the old
    single-shot path. The caller yields the final `done` event.

    progress_base / progress_span map the 0..1 fraction of THIS pass
    onto the overall progress scale (base=0 span=100 for single-pass).
    time_offset is added to every segment start/end so timestamps
    reflect the ORIGINAL file timeline. index_base is added to the
    per-chunk counter so indices stay monotonic across chunks.

    Final yield (type="_range_complete") carries the list of yielded
    segments and their count so the orchestrator can accumulate. That
    event is internal — the orchestrator strips it before re-yielding.
    """
    loop = asyncio.get_running_loop()
    temp_audio_path: str | None = None
    transcribe_file = source_file

    # Extract slice if requested
    if range_start is not None and range_end is not None:
        try:
            temp_audio_path = os.path.join(
                tempfile.gettempdir(),
                f"localsub_chunk_{job_id}_{int(range_start)}_{int(range_end)}.wav",
            )
            cmd = [
                _find_ffmpeg(), "-y",
                "-ss", str(range_start),
                "-to", str(range_end),
                "-i", source_file,
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                temp_audio_path,
            ]
            log.info(
                "[STT] Extracting audio segment: %s -> %s (%.1fs~%.1fs)",
                source_file, temp_audio_path, range_start, range_end,
            )
            result = subprocess.run(cmd, capture_output=True, timeout=120)
            if result.returncode != 0:
                log.warning("[STT] ffmpeg failed (rc=%d), using original file", result.returncode)
                temp_audio_path = None
            else:
                transcribe_file = temp_audio_path
        except FileNotFoundError:
            log.warning("[STT] ffmpeg not found, using original file")
            temp_audio_path = None
        except Exception as e:
            log.warning("[STT] ffmpeg extraction failed: %s, using original file", e)
            temp_audio_path = None

    log.info(
        "[STT] Transcribing range: file=%s, lang=%s, offset=%.1fs, base_idx=%d",
        transcribe_file, language_arg, time_offset, index_base,
    )

    segments_iter, info = await loop.run_in_executor(
        None,
        lambda: _model.transcribe(
            transcribe_file,
            language=language_arg,
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
        ),
    )

    info_duration = info.duration if info.duration and info.duration > 0 else (duration_hint or 1.0)

    yielded_segments: list[dict[str, Any]] = []
    local_index = 0

    def _consume_next(it):
        try:
            return next(it)
        except StopIteration:
            return None

    while True:
        if job["cancel_flag"]:
            job["state"] = SttJobState.CANCELED
            yield {"type": "cancelled", "job_id": job_id}
            return

        segment = await loop.run_in_executor(None, _consume_next, segments_iter)
        if segment is None:
            break

        seg_data = {
            "index": index_base + local_index,
            "start": round(segment.start + time_offset, 3),
            "end": round(segment.end + time_offset, 3),
            "text": segment.text.strip(),
        }
        yielded_segments.append(seg_data)

        yield {"type": "stt_segment", "job_id": job_id, **seg_data}

        inner_frac = min(segment.end / info_duration, 1.0)
        progress = min(int(progress_base + inner_frac * progress_span), 99)
        yield {
            "type": "stt_progress",
            "job_id": job_id,
            "progress": progress,
            "message": f"Transcribing... ({index_base + local_index + 1} segments)",
        }

        local_index += 1
        await asyncio.sleep(0)

    if temp_audio_path and os.path.exists(temp_audio_path):
        try:
            os.remove(temp_audio_path)
        except OSError:
            pass

    # Internal "end of this range" signal — orchestrator strips it.
    yield {
        "type": "_range_complete",
        "yielded": yielded_segments,
        "count": local_index,
    }


async def _run_whisper(job_id: str, job: dict) -> AsyncGenerator[dict[str, Any], None]:
    """Orchestrate one or many _transcribe_range calls.

    - User-supplied start_time/end_time (preview): single range call.
    - File ≤ LONG_FILE_THRESHOLD_S or probe failure: single call over
      the whole file.
    - Otherwise: split into CHUNK_DURATION_S slices, run sequentially,
      accumulate segment index, scale progress across chunks.
    """
    import time as _time
    _stt_start = _time.time()

    file_path = job["file_path"]
    language = job.get("language")
    lang_arg = language if language and language != "auto" else None
    user_start = job.get("start_time")
    user_end = job.get("end_time")

    all_segments: list[dict[str, Any]] = []

    # Preview mode — user asked for a specific window. Single pass.
    if user_start is not None and user_end is not None:
        async for ev in _transcribe_range(
            job_id, job, file_path, lang_arg,
            range_start=user_start, range_end=user_end,
            time_offset=user_start,
            progress_base=0.0, progress_span=100.0,
            index_base=0,
            duration_hint=(user_end - user_start),
        ):
            if ev.get("type") == "_range_complete":
                all_segments = ev["yielded"]
                continue
            if ev.get("type") == "cancelled":
                yield ev
                return
            yield ev
    else:
        # Full-file mode — _compute_chunks picks single-pass vs chunked.
        duration = _probe_duration(file_path)
        chunks = _compute_chunks(duration)
        log.info(
            "[STT] %s mode: duration=%s, chunks=%d",
            "Single-pass" if len(chunks) == 1 else "Chunked",
            f"{duration:.1f}s" if duration else "unknown",
            len(chunks),
        )
        index_base = 0
        for chunk_i, (c_start, c_end, p_base, p_span) in enumerate(chunks):
            if len(chunks) > 1:
                log.info(
                    "[STT] Chunk %d/%d: %.1fs~%.1fs (progress %.1f..%.1f)",
                    chunk_i + 1, len(chunks), c_start or 0.0, c_end or 0.0,
                    p_base, p_base + p_span,
                )
            async for ev in _transcribe_range(
                job_id, job, file_path, lang_arg,
                range_start=c_start, range_end=c_end,
                time_offset=(c_start or 0.0),
                progress_base=p_base, progress_span=p_span,
                index_base=index_base,
                duration_hint=(
                    (c_end - c_start) if (c_start is not None and c_end is not None)
                    else (duration or 1.0)
                ),
            ):
                if ev.get("type") == "_range_complete":
                    all_segments.extend(ev["yielded"])
                    index_base += ev["count"]
                    continue
                if ev.get("type") == "cancelled":
                    yield ev
                    return
                yield ev

    _stt_elapsed = _time.time() - _stt_start
    _durations = [s["end"] - s["start"] for s in all_segments]
    log.info(
        "[STT] Complete: %d segments in %.1fs, avg_dur=%.1fs, max_dur=%.1fs",
        len(all_segments), _stt_elapsed,
        sum(_durations) / len(_durations) if _durations else 0,
        max(_durations) if _durations else 0,
    )

    job["state"] = SttJobState.DONE
    log.info("[STT] Transcription complete, model kept loaded (Rust will unload before LLM)")
    yield {
        "type": "done",
        "job_id": job_id,
        "result": json.dumps(all_segments),
    }
