"""Regenerate the hash-locked Python closures for the embedded runtime.

    python scripts/lock_python.py base    # python-server/requirements.lock
    python scripts/lock_python.py qwen    # python-server/requirements-qwen.lock

Both locks target the bundled CPython (cp312, win_amd64) and pin one wheel per
package by SHA-256, so `pip install --require-hashes` refuses anything else.

- base: requirements.txt plus llama-cpp-python's runtime deps (the llama wheel
  itself is installed --no-deps from integrity.json).
- qwen: the Qwen3-ASR engine pack (requirements-qwen.txt), resolved against the
  base lock as constraints so no shared package changes version, and then
  stripped of every package the base lock already provides. The pack is
  installed --no-deps on top of the base environment. qwen-asr itself is
  downloaded --no-deps: its declared deps pull in demo/server packages
  (gradio, flask, vllm extras) that inference never imports.

Needs network access; pip comes from whatever Python runs this script.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "python-server"
TARGET = ["--only-binary=:all:", "--platform", "win_amd64", "--python-version", "3.12",
          "--implementation", "cp", "--abi", "cp312"]
# llama-cpp-python is installed --no-deps; these are what it imports.
LLAMA_RUNTIME = ["typing-extensions", "diskcache", "jinja2"]
# The pack's torch is the CUDA 12.6 build; everything else comes from PyPI.
TORCH_INDEX = "https://download.pytorch.org/whl/cu126"
# qwen-asr's own deps are not followed (see module docstring).
NO_DEPS = ["qwen-asr==0.0.6"]

WHEEL = re.compile(r"^(?P<name>[^-]+)-(?P<ver>[^-]+)-")


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "_", name).lower()


def pip_download(dest: Path, args: list[str]) -> None:
    subprocess.run([sys.executable, "-m", "pip", "download", "-q", "-d", str(dest), *TARGET, *args],
                   check=True)


def lock_lines(wheels: Path, exclude: set[str]) -> list[str]:
    lines = []
    for whl in sorted(wheels.glob("*.whl"), key=lambda p: p.name.lower()):
        m = WHEEL.match(whl.name)
        if not m:
            raise SystemExit(f"unexpected wheel name: {whl.name}")
        name = norm(m["name"])
        if name in exclude:
            continue
        digest = hashlib.sha256(whl.read_bytes()).hexdigest()
        lines.append(f"{name}=={m['ver']} --hash=sha256:{digest}")
    others = [p.name for p in wheels.iterdir() if not p.name.endswith(".whl")]
    if others:
        raise SystemExit(f"non-wheel downloads: {others}")
    return lines


def locked_names(lock: Path) -> set[str]:
    return {norm(l.split("==", 1)[0]) for l in lock.read_text(encoding="utf-8").splitlines()
            if l and not l.startswith("#")}


def base() -> None:
    """Re-resolve with the current lock as constraints, so only what
    requirements.txt changed moves; transitive packages keep their versions
    unless the new pins need something else (then they drop or get added)."""
    lock = SERVER / "requirements.lock"
    pinned = {norm(l.split("==", 1)[0]) for l in (SERVER / "requirements.txt").read_text(encoding="utf-8").splitlines()
              if "==" in l and not l.startswith("#")}
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        constraints = d / "constraints.txt"
        kept = [l.split(" ", 1)[0] for l in lock.read_text(encoding="utf-8").splitlines()
                if l and not l.startswith("#") and norm(l.split("==", 1)[0]) not in pinned]
        constraints.write_text("\n".join(kept) + "\n", encoding="utf-8")
        wheels = d / "wheels"
        pip_download(wheels, ["-r", str(SERVER / "requirements.txt"), *LLAMA_RUNTIME, "-c", str(constraints)])
        lines = lock_lines(wheels, set())
    header = """# Hash-locked dependency closure for the embedded runtime (cp312/win_amd64).
# Generated from requirements.txt + llama-cpp-python runtime deps
# (typing-extensions, diskcache, jinja2 -> MarkupSafe), full transitive set,
# by scripts/lock_python.py base (pip download --only-binary=:all:
# --platform win_amd64 --python-version 3.12 --abi cp312).
# Installed with 'pip install --require-hashes -r requirements.lock'; the
# llama-cpp wheel is then installed --no-deps. Regenerate when requirements.txt changes.
#
"""
    (SERVER / "requirements.lock").write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
    print(f"requirements.lock: {len(lines)} packages")


def qwen() -> None:
    base_lock = SERVER / "requirements.lock"
    exclude = locked_names(base_lock)
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        constraints = d / "constraints.txt"
        constraints.write_text(
            "\n".join(l.split(" ", 1)[0] for l in base_lock.read_text(encoding="utf-8").splitlines()
                      if l and not l.startswith("#")) + "\n", encoding="utf-8")
        wheels = d / "wheels"
        pip_download(wheels, ["-r", str(SERVER / "requirements-qwen.txt"), "-c", str(constraints),
                              "--extra-index-url", TORCH_INDEX])
        pip_download(wheels, ["--no-deps", *NO_DEPS])
        lines = lock_lines(wheels, exclude)
    header = """# Hash-locked Qwen3-ASR engine pack (cp312/win_amd64), installed on demand
# on top of the base environment when the user first downloads a Qwen model.
# Generated by scripts/lock_python.py qwen: requirements-qwen.txt resolved with
# requirements.lock as constraints, minus every package requirements.lock
# already pins (so the pack never changes a base package), plus qwen-asr
# --no-deps. torch is the CUDA 12.6 build from download.pytorch.org.
# Installed with 'pip install --require-hashes --no-deps --only-binary=:all:'.
#
--extra-index-url https://download.pytorch.org/whl/cu126
"""
    (SERVER / "requirements-qwen.lock").write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
    print(f"requirements-qwen.lock: {len(lines)} packages")


if __name__ == "__main__":
    {"base": base, "qwen": qwen}[sys.argv[1]]()
