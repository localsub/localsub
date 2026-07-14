import asyncio
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from llm_engine import create_translate_job, cancel_translate_job, get_translate_job, run_translate

router = APIRouter(prefix="/translate")


class GlossaryEntryRequest(BaseModel):
    source: str
    target: str


class TranslateStartRequest(BaseModel):
    segments: list[dict]
    source_lang: str = "auto"
    target_lang: str = "ko"
    context_window: int = 2
    style_preset: str = "natural"
    glossary: list[GlossaryEntryRequest] = []
    model_id: str | None = None
    n_gpu_layers: int | None = None
    translation_quality: str = "balanced"
    custom_prompt: str | None = None
    model_category: str = "instruct"
    media_filename: str | None = None
    media_context: str | None = None
    media_type: str | None = None
    translation_mode: str = "direct"
    pivot_language: str | None = None
    pivot_glossary: list[GlossaryEntryRequest] = []


class TranslateStartResponse(BaseModel):
    job_id: str


@router.post("/start", response_model=TranslateStartResponse)
async def start_translate(request: TranslateStartRequest):
    glossary = [{"source": g.source, "target": g.target} for g in request.glossary]
    job_id = create_translate_job(
        segments=request.segments,
        source_lang=request.source_lang,
        target_lang=request.target_lang,
        context_window=request.context_window,
        style_preset=request.style_preset,
        glossary=glossary,
        model_id=request.model_id,
        n_gpu_layers=request.n_gpu_layers,
        translation_quality=request.translation_quality,
        custom_prompt=request.custom_prompt,
        model_category=request.model_category,
        media_filename=request.media_filename,
        media_context=request.media_context,
        media_type=request.media_type,
        translation_mode=request.translation_mode,
        pivot_language=request.pivot_language,
        pivot_glossary=[
            {"source": g.source, "target": g.target}
            for g in request.pivot_glossary
        ],
    )
    return TranslateStartResponse(job_id=job_id)


@router.get("/stream/{job_id}")
async def stream_translate(job_id: str):
    job = get_translate_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Translate job not found")

    async def event_generator():
        async for event in run_translate(job_id):
            yield {"event": event["type"], "data": json.dumps(event)}
            if event["type"] in ("done", "error", "cancelled"):
                return
            await asyncio.sleep(0)

    return EventSourceResponse(event_generator())


@router.post("/cancel/{job_id}")
async def cancel_translate(job_id: str):
    success = cancel_translate_job(job_id)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot cancel translate job")
    return {"status": "cancelled"}
