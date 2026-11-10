"""STT orchestration: jobs, long-file chunking, audio extraction, SSE events.

The model itself sits behind an `stt_backends.SttBackend` (faster-whisper
today). Singleton pattern: one backend with one model is loaded and reused
across jobs.
"""

import asyncio
import json
import logging
import math
import os
import re
import subprocess
import tempfile
import time
import uuid
from enum import Enum
from pathlib import Path
from typing import Any, AsyncGenerator, Callable

log = logging.getLogger(__name__)

from stt_backends import DEFAULT_ENGINE, SttBackend, create_backend

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
# Extracting a range may take up to its own length (real time) and never less
# than this — a 30-minute slice of a large video on a USB disk or a network
# share is minutes of reading. Cancel stops it at once regardless.
EXTRACT_MIN_TIMEOUT_S = 5 * 60

# "Boost quiet speech" (config.boost_quiet_speech): raise quiet passages such as
# whispered lines before VAD and Whisper see them. Neither has a gain option of
# its own, so this is applied while ffmpeg extracts the 16 kHz mono audio.
# dynaudnorm adjusts gain per short window (200 ms frames, 11-frame Gaussian),
# unlike loudnorm, which only levels the file as a whole and leaves a whisper
# among normal lines just as quiet. m=20 (up to 26 dB) instead of the default
# 10 (20 dB): with TTS speech dropped 40 dB below its neighbours, the default
# still lost the passage to VAD and this setting recovered every line, while a
# 20 s noise-only gap stayed free of hallucinated text.
QUIET_SPEECH_FILTER = "dynaudnorm=f=200:g=11:m=20"


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

# The loaded backend, holding its model. Anything with a compatible
# `transcribe(path, language=...)` works here, which is what the tests rely on.
_backend: Any = None
_loaded_model_id: str | None = None
_loaded_engine: str | None = None


def _resolve_model_dir() -> Path:
    return Path(os.environ.get("MODEL_DIR", "./models"))


def load_model(model_id: str, engine: str = DEFAULT_ENGINE) -> bool:
    global _backend, _loaded_model_id, _loaded_engine

    if _backend is not None and _loaded_model_id == model_id and _loaded_engine == engine:
        return True  # already loaded

    # Unload previous model first
    unload_model()

    backend: SttBackend = create_backend(engine)
    # Runtime first: when the engine itself cannot load, that is the error the
    # user needs, even if the model files are missing too.
    backend.check_available()
    model_path = backend.find_model(_resolve_model_dir(), model_id)
    if model_path is None:
        raise FileNotFoundError(f"{backend.display_name} model not found: {model_id}")
    backend.load(model_path)
    _backend = backend
    _loaded_model_id = model_id
    _loaded_engine = engine
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            log.info("[STT] VRAM after load: %.0f/%.0f MB free", free / 1024 / 1024, total / 1024 / 1024)
    except Exception:  # noqa: BLE001 - a VRAM log line must never break a load
        # Not just ImportError: torch is optional here, but a torch that fails
        # to *load* raises OSError/RuntimeError, and this block only exists to
        # print a VRAM number. Letting that escape would break model loading
        # over a diagnostic.
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


def _run_ffmpeg(
    cmd: list[str], should_stop: Callable[[], bool], timeout_s: float,
) -> tuple[str, str]:
    """Run an ffmpeg command to completion; blocking, so call it off the loop.

    Polls ``should_stop`` so a cancelled job kills ffmpeg at once instead of
    waiting out the slice. stderr goes to a temp file, not a pipe: ffmpeg can
    write more than a pipe buffer holds and would then stall forever.

    Returns ``("ok", "")``, ``("cancelled", "")`` or ``("failed", reason)``.
    """
    with tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=err,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
        except OSError as e:
            return "failed", str(e)
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                rc = proc.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if should_stop():
                    proc.kill()
                    proc.wait()
                    return "cancelled", ""
                if time.monotonic() > deadline:
                    proc.kill()
                    proc.wait()
                    return "failed", f"timed out after {timeout_s:.0f}s"
        if rc == 0:
            return "ok", ""
        err.seek(0)
        tail = err.read()[-500:].decode("utf-8", errors="replace").strip()
        return "failed", f"exit code {rc}" + (f": {tail}" if tail else "")


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
    global _backend, _loaded_model_id, _loaded_engine
    log.info("[STT] Unloading model: %s", _loaded_model_id)
    if _backend is not None:
        _backend.unload()
    _backend = None
    _loaded_model_id = None
    _loaded_engine = None
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            vram_free = torch.cuda.mem_get_info()[0] / (1024 * 1024)
            log.info("[STT] CUDA cache cleared, VRAM free: %.0f MB", vram_free)
    except Exception:  # noqa: BLE001 - a VRAM log line must never break a load
        # Not just ImportError: torch is optional here, but a torch that fails
        # to *load* raises OSError/RuntimeError, and this block only exists to
        # print a VRAM number. Letting that escape would break model loading
        # over a diagnostic.
        pass


def is_model_loaded() -> bool:
    return _backend is not None


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
    boost_quiet_speech: bool = False,
) -> str:
    job_id = str(uuid.uuid4())
    _stt_jobs[job_id] = {
        "id": job_id,
        "file_path": file_path,
        "language": language,
        "model_id": model_id,
        "start_time": start_time,
        "end_time": end_time,
        "boost_quiet_speech": boost_quiet_speech,
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
    engine = DEFAULT_ENGINE
    if not model_id:
        model_dir = _resolve_model_dir()
        if model_dir.exists():
            probe = create_backend(engine)
            for d in model_dir.iterdir():
                if d.is_dir() and probe.find_model(model_dir, d.name) is not None:
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
            "message": f"Loading {create_backend(engine).display_name} model...",
        }
        try:
            await asyncio.get_running_loop().run_in_executor(None, load_model, model_id, engine)
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
        async for event in _run_transcription(job_id, job):
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
    whole_file: bool = False,
) -> AsyncGenerator[dict[str, Any], None]:
    """Run a single backend transcription pass, optionally on a
    time slice of `source_file`.

    `whole_file` says the slice spans the entire file, so a failed
    extraction may fall back to reading the file directly. For any
    narrower slice (a chunk, a preview window) that fallback would be
    wrong, and a failed extraction fails the job instead.

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

    try:
        # Extract slice if requested
        if range_start is not None and range_end is not None:
            temp_audio_path = os.path.join(
                tempfile.gettempdir(),
                f"localsub_chunk_{job_id}_{int(range_start)}_{int(range_end)}.wav",
            )
            cmd = [
                _find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
                "-ss", str(range_start),
                "-to", str(range_end),
                "-i", source_file,
            ]
            if job.get("boost_quiet_speech"):
                cmd += ["-af", QUIET_SPEECH_FILTER]
            cmd += [
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                temp_audio_path,
            ]
            log.info(
                "[STT] Extracting audio segment: %s -> %s (%.1fs~%.1fs, quiet-speech boost %s)",
                source_file, temp_audio_path, range_start, range_end,
                "on" if job.get("boost_quiet_speech") else "off",
            )
            # Off the event loop: while ffmpeg reads a slice (minutes, on a slow
            # disk) the server must keep answering /health, or the app
            # declares it crashed.
            status, detail = await loop.run_in_executor(
                None,
                _run_ffmpeg,
                cmd,
                lambda: job["cancel_flag"],
                max(EXTRACT_MIN_TIMEOUT_S, range_end - range_start),
            )
            if status == "cancelled":
                job["state"] = SttJobState.CANCELED
                yield {"type": "cancelled", "job_id": job_id}
                return
            if status == "ok":
                transcribe_file = temp_audio_path
            elif whole_file:
                # The range is the whole file: reading it directly loses nothing.
                log.warning("[STT] ffmpeg extraction failed (%s), using original file", detail)
                if job.get("boost_quiet_speech"):
                    log.warning("[STT] quiet-speech boost not applied: it needs the ffmpeg extraction")
            else:
                # Anything else would transcribe the WHOLE file at this range's
                # offset — a duplicated timeline running past the end.
                raise RuntimeError(
                    f"Could not extract audio {range_start:.0f}s-{range_end:.0f}s "
                    f"from {os.path.basename(source_file)}: ffmpeg {detail}"
                )
        elif job.get("boost_quiet_speech"):
            log.warning("[STT] quiet-speech boost not applied: duration unknown, so no ffmpeg extraction")

        log.info(
            "[STT] Transcribing range: file=%s, lang=%s, offset=%.1fs, base_idx=%d",
            transcribe_file, language_arg, time_offset, index_base,
        )

        backend = _backend
        segments_iter, info = await loop.run_in_executor(
            None,
            lambda: backend.transcribe(transcribe_file, language=language_arg),
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

        # Internal "end of this range" signal — orchestrator strips it.
        yield {
            "type": "_range_complete",
            "yielded": yielded_segments,
            "count": local_index,
            "language": getattr(info, "language", None),
        }
    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            try:
                os.remove(temp_audio_path)
            except OSError:
                pass


async def _run_transcription(job_id: str, job: dict) -> AsyncGenerator[dict[str, Any], None]:
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
    # (detected language, segments) per range, for the reported language
    ranges: list[tuple[str | None, list[dict[str, Any]]]] = []

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
                ranges.append((ev["language"], ev["yielded"]))
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
                whole_file=len(chunks) == 1,
            ):
                if ev.get("type") == "_range_complete":
                    all_segments.extend(ev["yielded"])
                    ranges.append((ev["language"], ev["yielded"]))
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

    # Translation reads its source language from this
    transcript_language = lang_arg or _dominant_language(ranges)
    log.info("[STT] Transcript language: %s (%s)", transcript_language, "forced" if lang_arg else "detected")

    job["state"] = SttJobState.DONE
    log.info("[STT] Transcription complete, model kept loaded (Rust will unload before LLM)")
    yield {
        "type": "done",
        "job_id": job_id,
        "result": json.dumps(all_segments),
        "language": transcript_language,
    }


def _dominant_language(ranges: list[tuple[str | None, list[dict[str, Any]]]]) -> str | None:
    """The detected language with the most transcribed speech. Each chunk of a
    long file runs its own detection, so chunks can disagree. None when no
    speech was transcribed: a guess made on silence means nothing."""
    speech: dict[str, float] = {}
    for lang, segments in ranges:
        if lang:
            speech[lang] = speech.get(lang, 0.0) + sum(s["end"] - s["start"] for s in segments)
    lang, seconds = max(speech.items(), key=lambda kv: kv[1], default=(None, 0.0))
    return lang if seconds > 0 else None
