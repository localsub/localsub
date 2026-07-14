import asyncio
import json
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from diarization_engine import (
    create_diarization_job,
    cancel_diarization_job,
    get_diarization_job,
    run_diarization,
)

router = APIRouter(prefix="/diarization")


class DiarSegmentInput(BaseModel):
    index: int
    start: float
    end: float
    text: str


class DiarizationStartRequest(BaseModel):
    file_path: str
    segments: list[DiarSegmentInput]
    model_id: str | None = None


class DiarizationStartResponse(BaseModel):
    job_id: str


@router.post("/start", response_model=DiarizationStartResponse)
async def start_diarization(request: DiarizationStartRequest):
    if not request.file_path or not os.path.isfile(request.file_path):
        raise HTTPException(status_code=400, detail="Invalid or missing file_path")
    if not request.segments:
        raise HTTPException(status_code=400, detail="No segments provided")

    segments_dict = [s.model_dump() for s in request.segments]
    job_id = create_diarization_job(
        file_path=request.file_path,
        segments=segments_dict,
        model_id=request.model_id,
    )
    return DiarizationStartResponse(job_id=job_id)


@router.get("/stream/{job_id}")
async def stream_diarization(job_id: str):
    job = get_diarization_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Diarization job not found")

    async def event_generator():
        async for event in run_diarization(job_id):
            yield {"event": event["type"], "data": json.dumps(event)}
            if event["type"] in ("done", "error", "cancelled"):
                return
            await asyncio.sleep(0)

    return EventSourceResponse(event_generator())


@router.post("/cancel/{job_id}")
async def cancel_diarization(job_id: str):
    success = cancel_diarization_job(job_id)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot cancel diarization job")
    return {"status": "cancelled"}
