"""Runtime management router — model status, load/unload, resource usage."""

import asyncio
import logging
import os
import subprocess

log = logging.getLogger(__name__)

import psutil
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import stt_engine
import llm_engine

router = APIRouter(prefix="/runtime")


# ── Request / Response models ─────────────────────────────────────

class LoadRequest(BaseModel):
    model_type: str  # "whisper" | "llm"
    model_id: str


class UnloadRequest(BaseModel):
    model_type: str  # "whisper" | "llm"


class ModelStatusResponse(BaseModel):
    whisper_status: str
    llm_status: str
    whisper_model_id: str | None
    llm_model_id: str | None


class LoadResponse(BaseModel):
    status: str
    model_type: str
    model_id: str


class UnloadResponse(BaseModel):
    status: str
    model_type: str


class ResourceResponse(BaseModel):
    ram_used_mb: float
    ram_total_mb: float
    vram_used_mb: float | None
    vram_total_mb: float | None


# ── Endpoints ─────────────────────────────────────────────────────

@router.get("/status", response_model=ModelStatusResponse)
async def get_status():
    return ModelStatusResponse(
        whisper_status="READY" if stt_engine.is_model_loaded() else "UNLOADED",
        llm_status="READY" if llm_engine.is_model_loaded() else "UNLOADED",
        whisper_model_id=stt_engine._loaded_model_id,
        llm_model_id=llm_engine._loaded_model_id,
    )


@router.post("/load", response_model=LoadResponse)
async def load_model(req: LoadRequest):
    if req.model_type not in ("whisper", "llm"):
        raise HTTPException(status_code=400, detail=f"Unknown model_type: {req.model_type}")

    loop = asyncio.get_running_loop()
    try:
        if req.model_type == "whisper":
            await loop.run_in_executor(None, stt_engine.load_model, req.model_id)
        else:
            await loop.run_in_executor(None, llm_engine.load_model, req.model_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return LoadResponse(status="READY", model_type=req.model_type, model_id=req.model_id)


@router.post("/unload", response_model=UnloadResponse)
async def unload_model(req: UnloadRequest):
    if req.model_type == "whisper":
        stt_engine.unload_model()
    elif req.model_type == "llm":
        llm_engine.unload_model()
    else:
        raise HTTPException(status_code=400, detail=f"Unknown model_type: {req.model_type}")

    # Verify VRAM is actually freed
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            vram_free = torch.cuda.mem_get_info()[0] / (1024 * 1024)
            vram_total = torch.cuda.mem_get_info()[1] / (1024 * 1024)
            log.info("[UNLOAD] %s unloaded. VRAM: %.0f/%.0f MB free", req.model_type, vram_free, vram_total)
    except ImportError:
        pass

    return UnloadResponse(status="UNLOADED", model_type=req.model_type)


@router.get("/resources", response_model=ResourceResponse)
async def get_resources():
    mem = psutil.virtual_memory()
    ram_used_mb = mem.used / (1024 * 1024)
    ram_total_mb = mem.total / (1024 * 1024)

    vram_used_mb = None
    vram_total_mb = None

    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if result.returncode == 0 and result.stdout.strip():
            line = result.stdout.strip().split("\n")[0]
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 2:
                vram_used_mb = float(parts[0])
                vram_total_mb = float(parts[1])
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError, ValueError):
        pass

    return ResourceResponse(
        ram_used_mb=round(ram_used_mb, 1),
        ram_total_mb=round(ram_total_mb, 1),
        vram_used_mb=round(vram_used_mb, 1) if vram_used_mb is not None else None,
        vram_total_mb=round(vram_total_mb, 1) if vram_total_mb is not None else None,
    )
