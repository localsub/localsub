import logging
import os
import sys
from pathlib import Path

# Embeddable Python (production bundle) uses python312._pth to control sys.path
# and does NOT auto-add the script's directory, so sibling imports (*_router,
# *_engine) fail. Add this file's directory explicitly.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI

# ── Logging setup ─────────────────────────────────────────────────
# Enable debug logging: set LOCALSUB_DEBUG=1 environment variable
_debug_mode = os.environ.get("LOCALSUB_DEBUG", "0") == "1"
_log_dir = Path(os.environ.get("APPDATA", ".")) / "LocalSub" / "logs"
_log_dir.mkdir(parents=True, exist_ok=True)

_log_level = logging.DEBUG if _debug_mode else logging.INFO
logging.basicConfig(
    level=_log_level,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(_log_dir / "server.log", encoding="utf-8"),
    ],
)
_main_log = logging.getLogger("main")
_main_log.info("Server starting (debug=%s, log_dir=%s)", _debug_mode, _log_dir)

from stt_router import router as stt_router
from translate_router import router as translate_router
from runtime_router import router as runtime_router
from diarization_router import router as diarization_router

app = FastAPI(title="AI Inference Server")
app.include_router(stt_router)
app.include_router(translate_router)
app.include_router(runtime_router)
app.include_router(diarization_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=9111)
