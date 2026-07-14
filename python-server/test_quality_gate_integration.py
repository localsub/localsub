"""Loop-level integration test for the structural quality gate.

Drives the real ``run_translate`` generator with a mock model (no llama_cpp, no
GPU) returning scripted outputs, to verify the wiring in llm_engine: detect bad
output -> retry -> recover, and persistent failure -> flag + blank.
"""
import asyncio
import json
import logging

import llm_engine


# (first_output, retry_output) keyed by a sentinel in the segment source text.
_SCRIPT = {
    "SRC_GOOD":       ("좋은 번역입니다", "좋은 번역입니다"),                # never bad
    "SRC_REPEAT":     ("좋은 번역입니다", "다른 번역"),                      # == prev -> repeat
    "SRC_REFUSE_OK":  ("I'm sorry, I can't translate this.", "회복된 번역"),  # off-language
    "SRC_KANA_OK":    ("점장님 ですね", "점장님"),                          # kana leak
    "SRC_REFUSE_BAD": ("I cannot help with that request here.",
                       "I still cannot help with that request here."),        # persists -> blank
}


class _MockModel:
    def __init__(self):
        self.calls: dict[str, int] = {}

    def create_chat_completion(self, messages, **kw):
        user = messages[-1]["content"]
        for key, (first, retry) in _SCRIPT.items():
            if key in user:
                n = self.calls.get(key, 0)
                self.calls[key] = n + 1
                return {"choices": [{"message": {"content": first if n == 0 else retry}}]}
        return {"choices": [{"message": {"content": "ok"}}]}


def test_quality_gate_retry_recover_and_flag():
    saved = (llm_engine.Llama, llm_engine._model, llm_engine._loaded_model_id)
    records: list[str] = []

    class _H(logging.Handler):
        def emit(self, r):
            records.append(r.getMessage())

    handler = _H()
    import embedding_gate
    saved_embed_state = embedding_gate._state
    try:
        # Force the semantic gate off so the test never triggers the (large)
        # model download; this test exercises the structural path only.
        embedding_gate._state = "unavailable"
        # load_model becomes a no-op: Llama non-None passes its guard, and a
        # preset _model with a matching id short-circuits before any real load.
        llm_engine.Llama = type("DummyLlama", (), {})
        llm_engine._model = _MockModel()
        llm_engine._loaded_model_id = "mock-model"
        llm_engine.log.addHandler(handler)
        llm_engine.log.setLevel(logging.INFO)

        segments = [
            {"text": k, "start": float(n), "end": float(n) + 1}
            for n, k in enumerate(
                ["SRC_GOOD", "SRC_REPEAT", "SRC_REFUSE_OK", "SRC_KANA_OK", "SRC_REFUSE_BAD"]
            )
        ]
        job_id = llm_engine.create_translate_job(
            segments=segments,
            source_lang="ja",
            target_lang="ko",
            translation_quality="balanced",
            model_id="mock-model",
            media_context="A test scene.",  # provided -> skip context inference
        )

        async def _run():
            done = None
            async for ev in llm_engine.run_translate(job_id):
                assert ev.get("type") != "error", ev
                if ev.get("type") == "done":
                    done = ev
            return done

        done = asyncio.run(_run())
        results = {r["index"]: r["translated"] for r in json.loads(done["result"])}

        assert results[0] == "좋은 번역입니다"   # good, untouched
        assert results[1] == "다른 번역"        # degenerate repeat -> retried
        assert results[2] == "회복된 번역"      # off-language refusal -> retried
        assert results[3] == "점장님"           # kana leak -> retried
        assert results[4] == ""                 # persistent refusal -> flagged + blanked

        complete = [m for m in records if "[TRANSLATE] Complete" in m]
        assert complete, "no completion log emitted"
        assert "flagged=1" in complete[-1], complete[-1]
    finally:
        llm_engine.log.removeHandler(handler)
        llm_engine.Llama, llm_engine._model, llm_engine._loaded_model_id = saved
        embedding_gate._state = saved_embed_state
