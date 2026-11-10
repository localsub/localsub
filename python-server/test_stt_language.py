"""The language STT reports with its result.

Translation takes its source language from this, so it has to name the
language actually transcribed: the forced one when the user picked a language,
otherwise Whisper's detection. A long file runs detection once per chunk, and
the chunks can disagree; the language with the most transcribed speech wins.
"""
import asyncio
import subprocess
from types import SimpleNamespace

import stt_engine

SRC = "C:/media/movie.mkv"


class _FakeWhisper:
    """Each call returns the next scripted (language, segment count) pair,
    one 5 s segment every 60 s. Records the language it was asked for."""

    def __init__(self, script: list[tuple[str, int]]):
        self.script = list(script)
        self.asked: list[str | None] = []

    def transcribe(self, path, language=None, **kw):
        self.asked.append(language)
        lang, count = self.script.pop(0)
        segs = [SimpleNamespace(start=t * 60.0, end=t * 60.0 + 5.0, text=f"{lang}{t}") for t in range(count)]
        return iter(segs), SimpleNamespace(duration=1800.0, language=lang, language_probability=0.9)


def _run(monkeypatch, duration: float, script: list[tuple[str, int]], language: str | None = None):
    fake = _FakeWhisper(script)
    monkeypatch.setattr(stt_engine, "_backend", fake)
    monkeypatch.setattr(stt_engine, "_loaded_model_id", "fake")
    monkeypatch.setattr(stt_engine, "_probe_duration", lambda p: duration)
    monkeypatch.setattr(stt_engine, "_find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        stt_engine.subprocess, "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, b"", b""),
    )

    class _Proc:
        returncode = 0

        def __init__(self, cmd, **kw):
            open(cmd[-1], "wb").close()

        def poll(self):
            return 0

        def wait(self, timeout=None):
            return 0

        def kill(self):
            pass

    monkeypatch.setattr(stt_engine.subprocess, "Popen", _Proc)

    job_id = stt_engine.create_stt_job(SRC, language=language, model_id="fake")

    async def collect():
        return [ev async for ev in stt_engine.run_stt(job_id)]

    events = asyncio.run(collect())
    done = [e for e in events if e["type"] == "done"]
    assert done, events
    return done[0], fake


def test_reports_the_detected_language(monkeypatch):
    done, fake = _run(monkeypatch, 1800.0, [("ja", 3)])
    assert fake.asked == [None]
    assert done["language"] == "ja"


def test_auto_is_detection_too(monkeypatch):
    done, fake = _run(monkeypatch, 1800.0, [("ko", 3)], language="auto")
    assert fake.asked == [None]
    assert done["language"] == "ko"


def test_reports_the_forced_language(monkeypatch):
    done, fake = _run(monkeypatch, 1800.0, [("ko", 3)], language="ko")
    assert fake.asked == ["ko"]
    assert done["language"] == "ko"


def test_long_file_takes_the_language_with_the_most_speech(monkeypatch):
    # 90 min -> three 30 min chunks. Two chunks say Japanese, but the English
    # chunk holds five times as much speech.
    done, fake = _run(monkeypatch, 5400.0, [("en", 10), ("ja", 1), ("ja", 1)])
    assert fake.asked == [None, None, None]
    assert done["language"] == "en"


def test_no_speech_reports_no_language(monkeypatch):
    # Detection on silence means nothing; translation then falls back to the
    # preset's language
    done, _ = _run(monkeypatch, 1800.0, [("nn", 0)])
    assert done["language"] is None
