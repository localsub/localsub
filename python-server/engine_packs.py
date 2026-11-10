"""Make an installed engine pack importable.

The app installs optional STT engines' packages (Qwen3-ASR: torch,
transformers, ...) into `<LOCALSUB_ENGINE_PACKS>/<engine>/` on demand
(src-tauri/src/engine_pack.rs). The server never imports them at startup;
a backend calls `activate()` when it loads, so a pack installed while the
server is running works without a restart.

The pack directory goes at the END of sys.path: it holds no package the base
environment pins (scripts/lock_python.py), so the base copy always wins and
one process never sees two versions of a package.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = ".complete"


def pack_dir(engine: str) -> Path | None:
    root = os.environ.get("LOCALSUB_ENGINE_PACKS")
    return Path(root) / engine if root else None


def activate(engine: str) -> str | None:
    """Put `engine`'s pack on sys.path. Returns None when it is ready, else
    the reason it is not (shown to the user via the backend's error)."""
    d = pack_dir(engine)
    if d is None:
        return "LOCALSUB_ENGINE_PACKS is not set"
    if not (d / MARKER).is_file():
        return f"the {engine} components are not installed"
    p = str(d)
    if p not in sys.path:
        sys.path.append(p)
    return None
