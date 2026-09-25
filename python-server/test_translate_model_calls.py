"""Every model call in a translation job must produce a subtitle line.

The prompt carries the segment text only (see ``prompt_builder.build_user_prompt``),
so any extra completion — a media-context pass or a rolling summary — would be
inference whose output nothing reads. With clean outputs (no gate retries) a
direct-mode job must therefore call the model exactly once per segment.
"""
import asyncio

import embedding_gate
import llm_engine


class _CountingModel:
    def __init__(self):
        self.user_prompts: list[str] = []

    def create_chat_completion(self, messages, **kw):
        user = messages[-1]["content"]
        self.user_prompts.append(user)
        # "セリフ12" -> "대사12": distinct, on-target, same length, so the gate
        # never asks for a retry.
        return {"choices": [{"message": {"content": user.replace("セリフ", "대사")}}]}


def test_direct_translation_calls_model_once_per_segment(monkeypatch):
    model = _CountingModel()
    monkeypatch.setattr(embedding_gate, "_state", "unavailable")
    monkeypatch.setattr(llm_engine, "Llama", type("DummyLlama", (), {}))
    monkeypatch.setattr(llm_engine, "_model", model)
    monkeypatch.setattr(llm_engine, "_loaded_model_id", "mock-model")

    # Long enough to cross the old 25-segment summary cadence twice.
    texts = [f"セリフ{n}" for n in range(60)]
    segments = [{"text": t, "start": float(n), "end": n + 1.0} for n, t in enumerate(texts)]
    job_id = llm_engine.create_translate_job(
        segments=segments,
        source_lang="ja",
        target_lang="ko",
        translation_quality="balanced",
        model_id="mock-model",
    )

    async def _run():
        async for ev in llm_engine.run_translate(job_id):
            assert ev.get("type") != "error", ev

    asyncio.run(_run())

    assert model.user_prompts == texts
