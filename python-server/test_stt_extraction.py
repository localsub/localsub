"""Audio-range extraction for STT: chunked files, previews and the event loop.

Drives the real ``run_stt`` with a fake Whisper model and a fake ffmpeg. The
fake stands in for both ``subprocess.run`` and ``subprocess.Popen`` so the same
scenarios hold whichever way the engine launches ffmpeg.
"""
import asyncio
import json
import os
import subprocess
import sys
import time
from types import SimpleNamespace

import stt_engine

SRC = "C:/media/movie.mkv"


class _FakeWhisper:
    """One segment every 600 s of whatever audio it is handed."""

    def __init__(self, source_length: float):
        self.source_length = source_length

    def transcribe(self, path, **kw):
        whole = path == SRC
        length = self.source_length if whole else 1800.0
        segs = [
            SimpleNamespace(start=float(t), end=t + 5.0, text=f"{'whole' if whole else 'slice'}@{t}")
            for t in range(0, int(length), 600)
        ]
        return iter(segs), SimpleNamespace(duration=length)


class _FakeFfmpeg:
    """Scripted ffmpeg: exits 1 for the slice starting at ``fail_at``, and
    takes ``seconds`` of wall time. Records when it ran and what it killed."""

    def __init__(self, fail_at: float | None = None, seconds: float = 0.0):
        self.fail_at = fail_at
        self.seconds = seconds
        self.windows: list[tuple[float, float]] = []
        self.killed: list[str] = []

    def _rc(self, cmd) -> int:
        return 1 if float(cmd[cmd.index("-ss") + 1]) == self.fail_at else 0

    def run(self, cmd, **kw):
        t0 = time.monotonic()
        time.sleep(self.seconds)
        self.windows.append((t0, time.monotonic()))
        return subprocess.CompletedProcess(cmd, self._rc(cmd), b"", b"")

    def Popen(self, cmd, **kw):
        fake = self
        out_path = cmd[-1]
        with open(out_path, "wb"):
            pass  # ffmpeg creates its output file as soon as it starts

        class _Proc:
            returncode = None

            def __init__(self):
                self.t0 = time.monotonic()
                self.t_end = self.t0 + fake.seconds

            def _finish(self, rc):
                if self.returncode is None:
                    self.returncode = rc
                    fake.windows.append((self.t0, time.monotonic()))
                return self.returncode

            def poll(self):
                if self.returncode is None and time.monotonic() >= self.t_end:
                    return self._finish(fake._rc(cmd))
                return self.returncode

            def wait(self, timeout=None):
                if self.returncode is not None:
                    return self.returncode
                remaining = self.t_end - time.monotonic()
                if self.returncode is None and timeout is not None and remaining > timeout:
                    time.sleep(timeout)
                    raise subprocess.TimeoutExpired(cmd, timeout)
                time.sleep(max(0.0, remaining))
                return self._finish(fake._rc(cmd))

            def kill(self):
                fake.killed.append(out_path)
                self.t_end = time.monotonic()
                self._finish(-9)

        return _Proc()


def _setup(monkeypatch, duration: float, ffmpeg: _FakeFfmpeg):
    monkeypatch.setattr(stt_engine, "_model", _FakeWhisper(duration))
    monkeypatch.setattr(stt_engine, "_loaded_model_id", "fake")
    monkeypatch.setattr(stt_engine, "_probe_duration", lambda p: duration)
    monkeypatch.setattr(stt_engine, "_find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(stt_engine.subprocess, "run", ffmpeg.run)
    monkeypatch.setattr(stt_engine.subprocess, "Popen", ffmpeg.Popen)


async def _events(job_id: str) -> list[dict]:
    return [ev async for ev in stt_engine.run_stt(job_id)]


def test_failed_chunk_fails_the_job_instead_of_transcribing_the_whole_file(monkeypatch):
    # 90 min -> chunks 0-1800, 1800-3600, 3600-5400; the middle one fails.
    _setup(monkeypatch, 5400.0, _FakeFfmpeg(fail_at=1800.0))
    job_id = stt_engine.create_stt_job(SRC, model_id="fake")

    events = asyncio.run(_events(job_id))

    starts = [e["start"] for e in events if e["type"] == "stt_segment"]
    assert max(starts) < 1800, f"segments past the failed chunk: {starts}"
    assert not [e for e in events if e["type"] == "done"], "a partial transcript was reported as done"
    errors = [e for e in events if e["type"] == "error"]
    assert errors and "1800" in errors[0]["error"], errors


def test_failed_preview_extraction_fails_instead_of_transcribing_the_whole_file(monkeypatch):
    _setup(monkeypatch, 5400.0, _FakeFfmpeg(fail_at=600.0))
    job_id = stt_engine.create_stt_job(SRC, model_id="fake", start_time=600.0, end_time=660.0)

    events = asyncio.run(_events(job_id))

    assert not [e for e in events if e["type"] == "stt_segment"]
    assert [e for e in events if e["type"] == "error"]


def test_single_pass_file_still_falls_back_to_the_original(monkeypatch):
    # A range that covers the whole file loses nothing by reading it directly.
    _setup(monkeypatch, 1800.0, _FakeFfmpeg(fail_at=0.0))
    job_id = stt_engine.create_stt_job(SRC, model_id="fake")

    events = asyncio.run(_events(job_id))

    done = [e for e in events if e["type"] == "done"]
    assert done, events
    texts = [s["text"] for s in json.loads(done[0]["result"])]
    assert texts == ["whole@0", "whole@600", "whole@1200"]


def test_extraction_does_not_block_the_event_loop(monkeypatch):
    # While ffmpeg runs, the server must keep answering /health — the app
    # declares it crashed after ten unanswered polls (about a minute).
    ffmpeg = _FakeFfmpeg(seconds=0.6)
    _setup(monkeypatch, 1800.0, ffmpeg)
    job_id = stt_engine.create_stt_job(SRC, model_id="fake")
    ticks: list[float] = []

    async def _main():
        async def ticker():
            while True:
                ticks.append(time.monotonic())
                await asyncio.sleep(0.02)

        t = asyncio.create_task(ticker())
        await _events(job_id)
        t.cancel()

    asyncio.run(_main())

    (start, end), = ffmpeg.windows
    during = [x for x in ticks if start < x < end]
    assert len(during) >= 5, f"event loop stalled for {end - start:.2f}s ({len(during)} ticks)"


def test_cancel_during_extraction_kills_ffmpeg_and_removes_the_slice(monkeypatch):
    ffmpeg = _FakeFfmpeg(seconds=5.0)
    _setup(monkeypatch, 5400.0, ffmpeg)
    job_id = stt_engine.create_stt_job(SRC, model_id="fake")

    async def _main():
        async def cancel_soon():
            await asyncio.sleep(0.3)
            stt_engine.cancel_stt_job(job_id)

        asyncio.create_task(cancel_soon())
        t0 = time.monotonic()
        events = await _events(job_id)
        return events, time.monotonic() - t0

    events, elapsed = asyncio.run(_main())

    assert [e for e in events if e["type"] == "cancelled"], events
    assert elapsed < 3.0, f"cancel waited for ffmpeg to finish ({elapsed:.1f}s)"
    assert len(ffmpeg.killed) == 1
    assert not os.path.exists(ffmpeg.killed[0]), "the half-written slice was left in %TEMP%"


def test_run_ffmpeg_kills_a_real_process_on_stop():
    t0 = time.monotonic()
    status, _ = stt_engine._run_ffmpeg(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        should_stop=lambda: time.monotonic() - t0 > 0.3,
        timeout_s=60,
    )
    assert status == "cancelled"
    assert time.monotonic() - t0 < 5


def test_run_ffmpeg_reports_a_failing_process_with_its_stderr():
    status, detail = stt_engine._run_ffmpeg(
        [sys.executable, "-c", "import sys; sys.stderr.write('No such file'); sys.exit(3)"],
        should_stop=lambda: False,
        timeout_s=60,
    )
    assert status == "failed"
    assert "3" in detail and "No such file" in detail


def test_run_ffmpeg_gives_up_after_its_timeout():
    t0 = time.monotonic()
    status, detail = stt_engine._run_ffmpeg(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        should_stop=lambda: False,
        timeout_s=0.5,
    )
    assert status == "failed" and "timed out" in detail
    assert time.monotonic() - t0 < 5
