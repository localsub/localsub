import asyncio
import json
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from stt_backends import DEFAULT_ENGINE
from stt_engine import create_stt_job, cancel_stt_job, get_stt_job, run_stt

router = APIRouter(prefix="/stt")


class SttStartRequest(BaseModel):
    file_path: str
    language: str | None = None
    model_id: str | None = None
    start_time: float | None = None
    end_time: float | None = None
    boost_quiet_speech: bool = False
    # Which STT backend runs the model, and helper models it needs by role
    # ({"aligner": "<model id>"}). The defaults are what every request meant
    # before engines existed.
    engine: str = DEFAULT_ENGINE
    aux_models: dict[str, str] = Field(default_factory=dict)


class SttStartResponse(BaseModel):
    job_id: str


@router.post("/start", response_model=SttStartResponse)
async def start_stt(request: SttStartRequest):
    if not request.file_path or not os.path.isfile(request.file_path):
        raise HTTPException(status_code=400, detail="Invalid or missing file_path")
    job_id = create_stt_job(
        file_path=request.file_path,
        language=request.language,
        model_id=request.model_id,
        start_time=request.start_time,
        end_time=request.end_time,
        boost_quiet_speech=request.boost_quiet_speech,
        engine=request.engine,
        aux_models=request.aux_models,
    )
    return SttStartResponse(job_id=job_id)


@router.get("/stream/{job_id}")
async def stream_stt(job_id: str):
    job = get_stt_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="STT job not found")

    async def event_generator():
        async for event in run_stt(job_id):
            yield {"event": event["type"], "data": json.dumps(event)}
            if event["type"] in ("done", "error", "cancelled"):
                return
            await asyncio.sleep(0)

    return EventSourceResponse(event_generator())


@router.post("/cancel/{job_id}")
async def cancel_stt(job_id: str):
    success = cancel_stt_job(job_id)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot cancel STT job")
    return {"status": "cancelled"}
