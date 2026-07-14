"""Tests for stt_engine helpers — pure function tests."""
import subprocess
from unittest import mock

import pytest

import stt_engine


def _ffprobe_result(returncode: int, stdout: bytes):
    completed = mock.Mock()
    completed.returncode = returncode
    completed.stdout = stdout
    return completed


def _ffmpeg_result(stderr: bytes):
    completed = mock.Mock()
    completed.returncode = 1  # `ffmpeg -i` with no output file always fails
    completed.stderr = stderr
    return completed


# ── _duration_via_ffprobe ─────────────────────────────────────────


def test_duration_via_ffprobe_parses_output():
    with mock.patch.object(subprocess, "run", return_value=_ffprobe_result(0, b"12649.651000\n")):
        assert stt_engine._duration_via_ffprobe("some.mp4") == 12649.651


def test_duration_via_ffprobe_handles_nonzero_exit():
    with mock.patch.object(subprocess, "run", return_value=_ffprobe_result(1, b"")):
        assert stt_engine._duration_via_ffprobe("missing.mp4") is None


def test_duration_via_ffprobe_handles_unparseable_output():
    with mock.patch.object(subprocess, "run", return_value=_ffprobe_result(0, b"not a number\n")):
        assert stt_engine._duration_via_ffprobe("weird.mp4") is None


def test_duration_via_ffprobe_handles_missing_binary():
    with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError()):
        assert stt_engine._duration_via_ffprobe("anything.mp4") is None


# ── _parse_ffmpeg_duration ────────────────────────────────────────


def test_parse_ffmpeg_duration_reads_banner():
    banner = "  Duration: 00:00:08.00, start: 0.000000, bitrate: 131 kb/s\n"
    assert stt_engine._parse_ffmpeg_duration(banner) == 8.0


def test_parse_ffmpeg_duration_handles_hours_and_fractions():
    banner = "  Duration: 03:31:29.65, start: 0.000000, bitrate: 900 kb/s\n"
    assert stt_engine._parse_ffmpeg_duration(banner) == pytest.approx(12689.65)


def test_parse_ffmpeg_duration_returns_none_for_na():
    assert stt_engine._parse_ffmpeg_duration("  Duration: N/A, bitrate: N/A\n") is None


def test_parse_ffmpeg_duration_returns_none_when_absent():
    assert stt_engine._parse_ffmpeg_duration("ffmpeg version 8.1.2\n") is None


# ── _probe_duration: ffprobe first, ffmpeg banner as fallback ─────


def test_probe_duration_prefers_ffprobe():
    with mock.patch.object(stt_engine, "_duration_via_ffprobe", return_value=42.0) as probe, \
         mock.patch.object(stt_engine, "_duration_via_ffmpeg") as ffmpeg:
        assert stt_engine._probe_duration("a.mp4") == 42.0
    probe.assert_called_once()
    ffmpeg.assert_not_called()


def test_probe_duration_falls_back_to_ffmpeg_when_ffprobe_unavailable():
    """The regression guard: a missing ffprobe used to silently disable chunking."""
    with mock.patch.object(stt_engine, "_duration_via_ffprobe", return_value=None), \
         mock.patch.object(stt_engine, "_duration_via_ffmpeg", return_value=5400.0):
        assert stt_engine._probe_duration("long.mp4") == 5400.0


def test_probe_duration_returns_none_when_both_probes_fail():
    with mock.patch.object(stt_engine, "_duration_via_ffprobe", return_value=None), \
         mock.patch.object(stt_engine, "_duration_via_ffmpeg", return_value=None):
        assert stt_engine._probe_duration("broken.mp4") is None


def test_probe_duration_fallback_parses_real_ffmpeg_banner():
    """End-to-end through the fallback: ffprobe missing, ffmpeg banner parsed."""
    banner = b"  Duration: 01:30:00.00, start: 0.000000, bitrate: 800 kb/s\n"

    def fake_run(cmd, **kwargs):
        if "ffprobe" in cmd[0]:
            raise FileNotFoundError()
        return _ffmpeg_result(banner)

    with mock.patch.object(subprocess, "run", side_effect=fake_run):
        assert stt_engine._probe_duration("long.mp4") == 5400.0


def test_compute_chunks_short_file_returns_single_pass():
    # 45 min file — under the 60-min threshold
    chunks = stt_engine._compute_chunks(45 * 60)
    assert chunks == [(0.0, 2700.0, 0.0, 100.0)]


def test_compute_chunks_exactly_threshold_stays_single_pass():
    # 60 min — boundary; no need to chunk
    chunks = stt_engine._compute_chunks(60 * 60)
    assert chunks == [(0.0, 3600.0, 0.0, 100.0)]


def test_compute_chunks_long_file_splits_into_30min_slices():
    # 2 h 30 min → five 30-min chunks
    chunks = stt_engine._compute_chunks(150 * 60)
    assert len(chunks) == 5
    assert chunks[0] == (0.0, 1800.0, 0.0, 20.0)
    assert chunks[1] == (1800.0, 3600.0, 20.0, 20.0)
    assert chunks[4] == (7200.0, 9000.0, 80.0, 20.0)
    # Progress windows sum to 100
    assert sum(span for _, _, _, span in chunks) == 100.0


def test_compute_chunks_uneven_tail():
    # 1 h 40 min → 4 chunks, last one 10 min
    chunks = stt_engine._compute_chunks(100 * 60)
    assert len(chunks) == 4
    assert chunks[-1][0] == 5400.0
    assert chunks[-1][1] == 6000.0
    # last chunk's progress span is (600 / 6000) * 100 = 10.0
    assert abs(chunks[-1][3] - 10.0) < 1e-6


def test_compute_chunks_probe_failure_returns_single_pass():
    chunks = stt_engine._compute_chunks(None)
    assert chunks == [(None, None, 0.0, 100.0)]
