"""/runtime/resources reports the GPU the server is pinned to.

The app starts this server with CUDA_VISIBLE_DEVICES=<uuid> and names the same
card in LOCALSUB_GPU_UUID. nvidia-smi ignores CUDA_VISIBLE_DEVICES and lists
every GPU, so without the explicit --id the usage shown would be whichever card
happens to be listed first.
"""
import asyncio
import subprocess

import runtime_router


def _nvidia_smi(calls: list, stdout: str):
    def run(cmd, **kw):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout, "")
    return run


def test_reports_the_pinned_gpu(monkeypatch):
    calls: list = []
    monkeypatch.setenv("LOCALSUB_GPU_UUID", "GPU-22222222-aaaa-bbbb-cccc-000000000000")
    monkeypatch.setattr(runtime_router.subprocess, "run", _nvidia_smi(calls, "20480, 24576\n"))

    res = asyncio.run(runtime_router.get_resources())

    assert "--id=GPU-22222222-aaaa-bbbb-cccc-000000000000" in calls[0]
    assert (res.vram_used_mb, res.vram_total_mb) == (20480.0, 24576.0)


def test_unpinned_server_still_reads_a_single_gpu(monkeypatch):
    calls: list = []
    monkeypatch.delenv("LOCALSUB_GPU_UUID", raising=False)
    monkeypatch.setattr(runtime_router.subprocess, "run", _nvidia_smi(calls, "1024, 8192\n"))

    res = asyncio.run(runtime_router.get_resources())

    assert not [a for a in calls[0] if a.startswith("--id=")]
    assert (res.vram_used_mb, res.vram_total_mb) == (1024.0, 8192.0)
