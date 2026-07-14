"""LLM engine wrapping llama-cpp-python.

Singleton model pattern: Llama is loaded once into `_model` and reused
across jobs to avoid repeated load times.
"""

import asyncio
import json
import logging
import os
import re
import uuid
from enum import Enum
from pathlib import Path
from typing import Any, AsyncGenerator

log = logging.getLogger(__name__)

try:
    from llama_cpp import Llama
except ImportError:
    Llama = None  # type: ignore[misc,assignment]

import embedding_gate
import gpu_utils
import prompt_builder
import quality_filters


# ── Model singleton ────────────────────────────────────────────────

_model: Any = None
_loaded_model_id: str | None = None


def _resolve_model_dir() -> Path:
    return Path(os.environ.get("MODEL_DIR", "./models"))


def _find_llm_model_path(model_id: str) -> Path | None:
    """Return the .gguf file path for the given model_id."""
    base = _resolve_model_dir() / model_id
    if not base.exists():
        return None
    for f in base.iterdir():
        if f.suffix == ".gguf" and f.is_file():
            return f
    return None


def load_model(model_id: str, n_gpu_layers: int | None = None) -> bool:
    global _model, _loaded_model_id

    if Llama is None:
        raise RuntimeError("llama-cpp-python is not installed")

    if _model is not None and _loaded_model_id == model_id:
        return True

    model_path = _find_llm_model_path(model_id)
    if model_path is None:
        raise FileNotFoundError(f"LLM model not found: {model_id}")

    if n_gpu_layers is None:
        n_gpu_layers = gpu_utils.get_llm_n_gpu_layers()

    # Log VRAM before loading
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            log.info("[LLM] VRAM before load: %.0f/%.0f MB free", free / 1024 / 1024, total / 1024 / 1024)
    except ImportError:
        pass

    # Try GPU first, fallback to CPU
    if n_gpu_layers != 0:
        try:
            _model = Llama(
                model_path=str(model_path),
                n_gpu_layers=n_gpu_layers,
                n_ctx=8192,
                verbose=False,
            )
            _loaded_model_id = model_id
            # Log VRAM after loading
            try:
                if torch.cuda.is_available():
                    free, total = torch.cuda.mem_get_info()
                    log.info("[LLM] VRAM after load: %.0f/%.0f MB free", free / 1024 / 1024, total / 1024 / 1024)
            except Exception:
                pass
            return True
        except Exception as e:
            log.warning("GPU load failed, falling back to CPU: %s", e)

    _model = Llama(
        model_path=str(model_path),
        n_gpu_layers=0,
        n_ctx=8192,
        verbose=False,
    )
    _loaded_model_id = model_id
    return True


def unload_model() -> None:
    global _model, _loaded_model_id
    log.info("[LLM] Unloading model: %s", _loaded_model_id)
    _model = None
    _loaded_model_id = None
    # Force GPU memory release
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            log.info("[LLM] CUDA cache cleared")
    except ImportError:
        pass


def is_model_loaded() -> bool:
    return _model is not None


# ── Output postprocessing ──────────────────────────────────────────

def _postprocess(raw: str) -> str:
    """Clean LLM output: strip prefixes, quotes, backticks, think blocks, prompt leakage."""
    text = raw.strip()

    # Strip <think>...</think> blocks (Qwen3 thinking mode leakage)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    # Strip prompt leakage: timestamp markers like [00:12:34] or >>> markers
    text = re.sub(r"^>>>?\s*", "", text)
    text = re.sub(r"\[?\d{2}:\d{2}:\d{2}\]?\s*", "", text)

    # If output contains multiple lines with timestamps, keep only the first clean line
    lines = text.split("\n")
    clean_lines = []
    for line in lines:
        line = line.strip()
        # Remove lines that are just timestamps or prompt artifacts
        line = re.sub(r"^>>>?\s*", "", line)
        line = re.sub(r"^\[?\d{2}:\d{2}:\d{2}\]?\s*", "", line)
        if line:
            clean_lines.append(line)
    # For single-segment translation, take only the first meaningful line
    text = clean_lines[0] if clean_lines else ""

    # Strip common prefixes
    for prefix in [
        "Translation:", "translation:", "번역:", "Answer:", "answer:",
        "Output:", "output:", "Translated:", "translated:",
    ]:
        if text.startswith(prefix):
            text = text[len(prefix):].strip()

    # Strip wrapping quotes (double or single)
    if len(text) >= 2:
        if (text[0] == '"' and text[-1] == '"') or (text[0] == "'" and text[-1] == "'"):
            text = text[1:-1].strip()

    # Strip wrapping backticks
    if len(text) >= 2 and text[0] == '`' and text[-1] == '`':
        text = text[1:-1].strip()

    # Strip triple backtick blocks
    if text.startswith("```") and text.endswith("```"):
        text = text[3:-3].strip()

    # Strip leading dashes (prompt format leakage)
    text = re.sub(r"^-{1,2}\s*", "", text).strip()

    return text


# Refusal detection — require BOTH a "cannot/can't/수 없" signal AND a
# policy/content-moderation marker. Short strings never count as refusals,
# so legit translations like "I'm sorry." or "죄송합니다." are safe.
#
# Marker lists derived from real refusal samples emitted by the models we
# ship (Qwen 3.5 9B family). Tightened to avoid common-word collisions:
# bare "sexual", bare "violence" are excluded because they can appear in
# legitimate subtitle lines; we require compound/policy-framed phrases.
_REFUSAL_INABILITY_RE = re.compile(
    r"(?:수\s*없(?:습니다|어요|음|다)"      # 한국어: …수 없습니다 / 없어요 등
    r"|\bcannot\b|\bcan'?t\b"
    r"|\bunable\s+to\b|\bwon'?t\b"
    r"|\bam\s+not\s+able\s+to\b"
    r"|do\s+not\s+(?:provide|generate|translate))",
    re.IGNORECASE,
)

_REFUSAL_POLICY_RE = re.compile(
    # Korean policy/content markers
    r"(?:죄송"                                  # "죄송하지만", "죄송합니다"
    r"|성적인\s*\S+"                            # "성적인 콘텐츠/내용/명칭/표현"
    r"|폭력적인\s*\S+"                          # "폭력적인 콘텐츠/내용/장면"
    r"|노골적"
    r"|포르노"
    r"|유해\s*(?:콘텐츠|내용|표현)"
    r"|혐오\s*(?:표현|발언|콘텐츠)"
    r"|불법(?:적인)?\s*(?:행위|콘텐츠|내용)"
    r"|(?:안전|콘텐츠|번역기)\s*(?:가이드|정책|규정)"
    r"|(?:이|해당)?\s*요청(?:은|을)?\s*처리"    # "요청은 처리할 수 없"
    # English policy/content markers — require compound phrasings to avoid
    # false-positives on bare words like "sexual" / "violence" in legit lines.
    r"|as\s+an?\s+AI"
    r"|against\s+(?:my|our|the|these)\s+"
    r"(?:safety\s+)?(?:guideline|polic)"
    r"|safety\s+guideline"
    r"|content\s+polic"
    r"|violate[sd]?\s+(?:\S+\s+){0,3}(?:guideline|polic|rule)"
    # Sexual-content refusals
    r"|sexually\s+explicit"
    r"|explicit\s+content"
    r"|pornograph"
    r"|non[-\s]consensual"
    r"|sexual\s+violence"
    r"|adult\s+themes?"
    # Violence / harm / hate / illegal refusals — compound only
    r"|graphic\s+violence"
    r"|\bgore\b|\bgory\b"
    r"|harmful\s+content"
    r"|hate\s+speech"
    r"|self[-\s]harm"
    r"|illegal\s+(?:activit|act|content|conduct)"
    r"|glorif(?:y|ies|ying|ication\s+of)\s+violence"
    r"|promot(?:e|es|ing)\s+violence"
    r")",
    re.IGNORECASE,
)


def _looks_like_refusal(text: str) -> bool:
    """Detect LLM refusal / policy-deflection output.

    Conservative two-signal design: requires BOTH an inability marker
    ("cannot" / "수 없" / …) AND a policy or content-moderation marker
    somewhere in the text. Strings under 20 chars are never refusals,
    so short legit translations containing apology words are safe.
    """
    if not text:
        return False
    stripped = text.strip()
    if len(stripped) < 20:
        return False
    return bool(
        _REFUSAL_INABILITY_RE.search(stripped)
        and _REFUSAL_POLICY_RE.search(stripped)
    )


def _fix_untranslated(
    original: str,
    translated: str,
    vocabulary: list[dict[str, str]] | None = None,
) -> str:
    """If the translation is empty or identical to the original,
    substitute from the supplied vocabulary. Otherwise return
    `translated` unchanged.

    Vocabulary entries must have non-empty `source` AND `target`.
    Match is exact on the trimmed source string.
    """
    stripped_orig = original.strip()
    stripped_trans = translated.strip()

    if stripped_trans and stripped_trans != stripped_orig:
        return translated

    for entry in (vocabulary or []):
        entry_src = (entry.get("source") or "").strip()
        entry_tgt = (entry.get("target") or "").strip()
        if not entry_src or not entry_tgt:
            continue
        if entry_src == stripped_orig:
            return entry_tgt

    return translated


def _bad_output_reason(
    original: str,
    translated: str,
    target_lang: str,
    prev_original: str,
    prev_translated: str,
) -> str | None:
    """Quality gate: return a short reason code when ``translated`` is not a
    usable translation of ``original`` (caller should retry), else ``None``.

    Combines the (brittle, model-specific) phrase-based refusal check with
    model-agnostic structural signals — script leak, off-target language,
    length blow-up — and degenerate repetition. The structural signals are what
    make this robust to refusals that are worded differently every generation
    and across models; the phrase check stays only as an extra cheap signal.
    """
    if _looks_like_refusal(translated):
        return "refusal"
    reason = quality_filters.classify_bad_translation(original, translated, target_lang)
    if reason:
        return reason
    if quality_filters.is_degenerate_repeat(original, prev_original, translated, prev_translated):
        return "repeat"
    # Semantic gate (last): catches a refusal phrased in the target language —
    # structurally a normal line, but unrelated in meaning to the source. No-op
    # if the embedding model is unavailable. Not blanked on persistent failure
    # (it can false-positive on loose-but-valid lines), only retried + flagged.
    if embedding_gate.semantic_mismatch(original, translated):
        return "low_similarity"
    return None


# ── Quality tier sampling parameters ───────────────────────────────

QUALITY_SAMPLING: dict[str, dict[str, float]] = {
    "fast": {"temperature": 0.1, "top_p": 0.8, "repeat_penalty": 1.0},
    "balanced": {"temperature": 0.3, "top_p": 0.9, "repeat_penalty": 1.2},
    "best": {"temperature": 0.3, "top_p": 0.95, "repeat_penalty": 1.2},
}

# ── Dynamic few-shot ─────────────────────────────────────────────
# Number of most recent successful translations to inject as additional
# chat turns for each segment. Validated on Qwen 3.5 9B Q5_K_M via
# test_fewshot_30_q5km.py D-variant to measurably improve style
# consistency (scene-local tone, character voice). 0 disables.
RECENT_FEW_SHOT_WINDOW = 3


# ── Job management ─────────────────────────────────────────────────

class TranslateJobState(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


_translate_jobs: dict[str, dict[str, Any]] = {}


SUMMARY_INTERVAL = 25  # Generate rolling summary every N segments
SUMMARY_REFRESH = 200  # Regenerate summary from scratch every N segments


def create_translate_job(
    segments: list[dict[str, Any]],
    source_lang: str,
    target_lang: str,
    context_window: int = 4,
    style_preset: str = "natural",
    glossary: list[dict[str, str]] | None = None,
    model_id: str | None = None,
    n_gpu_layers: int | None = None,
    translation_quality: str = "balanced",
    custom_prompt: str | None = None,
    model_category: str = "instruct",
    media_filename: str | None = None,
    media_context: str | None = None,
    media_type: str | None = None,
    translation_mode: str = "direct",
    pivot_language: str | None = None,
    pivot_glossary: list[dict[str, str]] | None = None,
) -> str:
    job_id = str(uuid.uuid4())
    _translate_jobs[job_id] = {
        "id": job_id,
        "segments": segments,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "context_window": context_window,
        "style_preset": style_preset,
        "glossary": glossary or [],
        "model_id": model_id,
        "n_gpu_layers": n_gpu_layers,
        "translation_quality": translation_quality,
        "custom_prompt": custom_prompt,
        "model_category": model_category,
        "media_filename": media_filename,
        "media_context": media_context,
        "media_type": media_type,
        "translation_mode": translation_mode,
        "pivot_language": pivot_language,
        "pivot_glossary": pivot_glossary or [],
        "state": TranslateJobState.QUEUED,
        "cancel_flag": False,
    }
    return job_id


def cancel_translate_job(job_id: str) -> bool:
    job = _translate_jobs.get(job_id)
    if job is None:
        return False
    if job["state"] in (TranslateJobState.DONE, TranslateJobState.FAILED, TranslateJobState.CANCELED):
        return False
    job["cancel_flag"] = True
    return True


def get_translate_job(job_id: str) -> dict[str, Any] | None:
    return _translate_jobs.get(job_id)


def cleanup_job(job_id: str) -> None:
    """Remove a terminal-state job from memory."""
    job = _translate_jobs.get(job_id)
    if job and job["state"] in (
        TranslateJobState.DONE,
        TranslateJobState.FAILED,
        TranslateJobState.CANCELED,
    ):
        del _translate_jobs[job_id]


def _auto_purge_jobs() -> None:
    """Auto-purge oldest completed jobs when dict exceeds 100 entries."""
    if len(_translate_jobs) <= 100:
        return
    terminal = [
        jid
        for jid, j in _translate_jobs.items()
        if j["state"] in (TranslateJobState.DONE, TranslateJobState.FAILED, TranslateJobState.CANCELED)
    ]
    for jid in terminal:
        del _translate_jobs[jid]
        if len(_translate_jobs) <= 100:
            break


# ── SSE generator ──────────────────────────────────────────────────

async def run_translate(job_id: str) -> AsyncGenerator[dict[str, Any], None]:
    """Async generator yielding SSE events during translation."""
    job = _translate_jobs.get(job_id)
    if job is None:
        yield {"type": "error", "job_id": job_id, "error": "Job not found"}
        return

    job["state"] = TranslateJobState.RUNNING

    # Determine model_id — fallback to first available LLM model
    model_id = job.get("model_id")
    if not model_id:
        model_dir = _resolve_model_dir()
        if model_dir.exists():
            for d in model_dir.iterdir():
                if d.is_dir() and any(f.suffix == ".gguf" for f in d.iterdir() if f.is_file()):
                    model_id = d.name
                    break
    if not model_id:
        yield {"type": "error", "job_id": job_id, "error": "No LLM model available"}
        job["state"] = TranslateJobState.FAILED
        cleanup_job(job_id)
        return

    # Load model if needed
    if not is_model_loaded() or _loaded_model_id != model_id:
        yield {
            "type": "translate_progress",
            "job_id": job_id,
            "progress": 0,
            "message": "Loading LLM model...",
        }
        try:
            _n_gpu = job.get("n_gpu_layers")
            await asyncio.get_running_loop().run_in_executor(
                None, load_model, model_id, _n_gpu
            )
        except Exception as e:
            yield {"type": "error", "job_id": job_id, "error": f"Failed to load LLM: {e}"}
            job["state"] = TranslateJobState.FAILED
            cleanup_job(job_id)
            return

    # Warm the semantic gate now (one-time model download) so it doesn't stall
    # the first segment mid-loop. Best-effort: a failure just disables the gate.
    await asyncio.get_running_loop().run_in_executor(None, embedding_gate.warm)

    if job["cancel_flag"]:
        job["state"] = TranslateJobState.CANCELED
        yield {"type": "cancelled", "job_id": job_id}
        cleanup_job(job_id)
        return

    segments = job["segments"]
    source_lang = job["source_lang"]
    target_lang = job["target_lang"]
    context_window = job["context_window"]
    style_preset = job["style_preset"]
    glossary = job["glossary"]
    translation_mode = job.get("translation_mode", "direct")
    pivot_language = job.get("pivot_language") or "en"
    pivot_glossary = job.get("pivot_glossary", []) or []
    quality = job.get("translation_quality", "balanced")
    custom_prompt = job.get("custom_prompt")
    model_category = job.get("model_category", "instruct")
    media_filename = job.get("media_filename")
    media_context = job.get("media_context")
    media_type = job.get("media_type")
    total = len(segments)
    all_results: list[dict[str, Any]] = []
    completed_translations: dict[int, str] = {}
    sampling = QUALITY_SAMPLING.get(quality, QUALITY_SAMPLING["balanced"])
    rolling_summary: str | None = None
    # Count of segments still flagged as bad output after a retry (for the
    # completion log / review). See _bad_output_reason.
    _flagged_count = 0
    # Dynamic few-shot: ring buffer of the last N successful (non-echo) translations.
    # Injected into each segment's prompt as additional chat turns.
    recent_buffer: list[dict[str, str]] = []

    # Auto-infer media context from first segments if not provided
    if not media_context and total > 0:
        yield {
            "type": "translate_progress",
            "job_id": job_id,
            "progress": 0,
            "message": "Analyzing content for context...",
        }
        try:
            loop = asyncio.get_running_loop()
            sample_count = min(100, total)
            sample_lines = "\n".join(
                seg.get("text", "") for seg in segments[:sample_count]
            )
            context_msgs = [
                {
                    "role": "system",
                    "content": (
                        "You are a media analyst. Based on the subtitle lines below, "
                        "write a brief context description (3-5 sentences) covering:\n"
                        "- What type of content this is (movie, drama, documentary, etc.)\n"
                        "- Genre and tone (comedy, thriller, romance, etc.)\n"
                        "- Key character names mentioned and their apparent roles\n"
                        "- General setting or situation\n"
                        "Output ONLY the description. No labels or formatting.\n"
                        "/no_think"
                    ),
                },
                {"role": "user", "content": f"Subtitle lines:\n{sample_lines}"},
            ]

            def _infer_context(msgs=context_msgs):
                return _model.create_chat_completion(
                    messages=msgs, max_tokens=300,
                    temperature=0.2, top_p=0.9,
                )

            ctx_resp = await loop.run_in_executor(None, _infer_context)
            if ctx_resp and "choices" in ctx_resp:
                raw = ctx_resp["choices"][0].get("message", {}).get("content") or ""
                raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
                if raw:
                    media_context = raw
                    log.info("Auto-inferred media context: %s", media_context[:200])
        except Exception as e:
            log.warning("Failed to auto-infer media context: %s", e)

    yield {
        "type": "translate_progress",
        "job_id": job_id,
        "progress": 0,
        "message": "Starting translation...",
    }

    import time as _time
    _translate_start = _time.time()
    log.info(
        "[TRANSLATE] Starting: %d segments, model=%s, quality=%s, mode=%s, pivot=%s, context=%s",
        total, _loaded_model_id, quality, translation_mode,
        pivot_language if translation_mode == "pivot_2pass" else "-",
        media_context[:80] if media_context else "none",
    )
    # Progress scales 1:1 over a single pass.
    pass1_weight = 1.0

    try:
        loop = asyncio.get_running_loop()

        # ── Pass 1: Batch translation ──────────────────────────
        # The system prompt is the same for every segment, so log it once — in
        # full — rather than truncating it on each one. Re-logged if it changes.
        _last_system_prompt: str | None = None
        i = 0
        while i < total:
            if job["cancel_flag"]:
                job["state"] = TranslateJobState.CANCELED
                yield {"type": "cancelled", "job_id": job_id}
                return

            # Single segment — dispatch direct vs pivot 2-pass.
            recent_slice = (
                recent_buffer[-RECENT_FEW_SHOT_WINDOW:]
                if RECENT_FEW_SHOT_WINDOW > 0 else []
            )

            if translation_mode == "pivot_2pass":
                # Leg 1 — source → pivot language, pivot glossary only.
                leg1_msgs = prompt_builder.build_messages(
                    segments, i,
                    source_lang=source_lang,
                    target_lang=pivot_language,
                    context_window=context_window,
                    style_preset=style_preset,
                    glossary=pivot_glossary,
                    translations={},  # no prior-context for pivot leg
                    custom_prompt=custom_prompt,
                    model_category=model_category,
                    media_filename=media_filename,
                    media_context=media_context,
                    media_type=media_type,
                    recent_examples=[],  # recent is final-leg only
                )

                log.debug("[TRANSLATE] seg=%d leg1_system=%s", i, leg1_msgs[0]["content"][:100])
                log.debug("[TRANSLATE] seg=%d leg1_user=%s", i, leg1_msgs[-1]["content"][:300])

                def _infer_pivot(msgs=leg1_msgs, samp=sampling):
                    return _model.create_chat_completion(
                        messages=msgs,
                        max_tokens=512,
                        temperature=samp["temperature"],
                        top_p=samp["top_p"],
                        repeat_penalty=samp["repeat_penalty"],
                    )

                pivot_resp = await loop.run_in_executor(None, _infer_pivot)
                pivot_text = ""
                if pivot_resp and "choices" in pivot_resp and len(pivot_resp["choices"]) > 0:
                    pivot_raw = pivot_resp["choices"][0].get("message", {}).get("content") or ""
                    pivot_text = _postprocess(pivot_raw)

                log.debug("[TRANSLATE] seg=%d pivot_text=%s", i, pivot_text[:150])

                if not pivot_text:
                    # Leg 1 gave nothing — record an empty translation and move on.
                    translated = ""
                    raw_content = ""
                else:
                    # Leg 2 — pivot language → target, final glossary + recent buffer.
                    leg2_segments = [{
                        "start": segments[i].get("start", 0.0),
                        "end": segments[i].get("end", 0.0),
                        "text": pivot_text,
                    }]
                    leg2_msgs = prompt_builder.build_messages(
                        leg2_segments, 0,
                        source_lang=pivot_language,
                        target_lang=target_lang,
                        context_window=context_window,
                        style_preset=style_preset,
                        glossary=glossary,
                        translations={},
                        custom_prompt=custom_prompt,
                        model_category=model_category,
                        media_filename=media_filename,
                        media_context=media_context,
                        media_type=media_type,
                        recent_examples=recent_slice,
                    )

                    log.debug("[TRANSLATE] seg=%d leg2_user=%s", i, leg2_msgs[-1]["content"][:300])

                    def _infer_final(msgs=leg2_msgs, samp=sampling):
                        return _model.create_chat_completion(
                            messages=msgs,
                            max_tokens=512,
                            temperature=samp["temperature"],
                            top_p=samp["top_p"],
                            repeat_penalty=samp["repeat_penalty"],
                        )

                    final_resp = await loop.run_in_executor(None, _infer_final)
                    translated = ""
                    raw_content = ""
                    if final_resp and "choices" in final_resp and len(final_resp["choices"]) > 0:
                        raw_content = final_resp["choices"][0].get("message", {}).get("content") or ""
                        translated = _postprocess(raw_content)

                        # Refusal retry on the final leg (pivot mode).
                        if _looks_like_refusal(translated):
                            log.warning(
                                "[TRANSLATE] seg=%d pivot-final refusal detected, retrying: %s",
                                i, translated[:80],
                            )
                            retry_samp = dict(sampling)
                            retry_samp["temperature"] = min(sampling["temperature"] + 0.4, 1.0)

                            def _infer_final_retry(msgs=leg2_msgs, samp=retry_samp):
                                return _model.create_chat_completion(
                                    messages=msgs,
                                    max_tokens=512,
                                    temperature=samp["temperature"],
                                    top_p=samp["top_p"],
                                    repeat_penalty=samp["repeat_penalty"],
                                )

                            retry_resp = await loop.run_in_executor(None, _infer_final_retry)
                            if retry_resp and "choices" in retry_resp and len(retry_resp["choices"]) > 0:
                                retry_raw = retry_resp["choices"][0].get("message", {}).get("content") or ""
                                retry_translated = _postprocess(retry_raw)
                                if retry_translated and not _looks_like_refusal(retry_translated):
                                    log.info("[TRANSLATE] seg=%d pivot-final retry succeeded", i)
                                    translated = retry_translated
                                    raw_content = retry_raw
                                else:
                                    log.warning("[TRANSLATE] seg=%d pivot-final retry still refusal, keeping empty", i)
                                    translated = ""

                        translated = _fix_untranslated(
                            segments[i].get("text", ""), translated, vocabulary=glossary,
                        )
            else:
                # Direct mode — single build_messages call (unchanged logic).
                messages = prompt_builder.build_messages(
                    segments, i,
                    source_lang=source_lang,
                    target_lang=target_lang,
                    context_window=context_window,
                    style_preset=style_preset,
                    glossary=glossary,
                    translations=completed_translations,
                    custom_prompt=custom_prompt,
                    model_category=model_category,
                    rolling_summary=rolling_summary,
                    media_filename=media_filename,
                    media_context=media_context,
                    media_type=media_type,
                    recent_examples=recent_slice,
                )

                # The `/no_think` directive is the LAST line of the system prompt,
                # so truncating this log hid the one thing it exists to reveal:
                # whether the Qwen3-only directive was injected. Log it in full.
                system_prompt = messages[0]["content"]
                if system_prompt != _last_system_prompt:
                    log.debug(
                        "[TRANSLATE] system_prompt (%d chars, category=%s):\n%s",
                        len(system_prompt), model_category, system_prompt,
                    )
                    _last_system_prompt = system_prompt
                log.debug("[TRANSLATE] seg=%d prompt_user(first 300)=%s", i, messages[1]["content"][:300])

                def _infer_single(msgs=messages, samp=sampling):
                    return _model.create_chat_completion(
                        messages=msgs,
                        max_tokens=512,
                        temperature=samp["temperature"],
                        top_p=samp["top_p"],
                        repeat_penalty=samp["repeat_penalty"],
                    )

                response = await loop.run_in_executor(None, _infer_single)
                translated = ""
                raw_content = ""
                if response and "choices" in response and len(response["choices"]) > 0:
                    raw_content = response["choices"][0].get("message", {}).get("content") or ""
                    translated = quality_filters.collapse_immediate_repeats(_postprocess(raw_content))

                    # Structural quality gate: detect output that is not a
                    # valid translation — a refusal (any wording / any model),
                    # a source-script leak, wrong-language meta-text, an
                    # over-long disclaimer, or a degenerate repeat of the
                    # previous line — and retry once at a higher temperature.
                    orig_text = segments[i].get("text", "")
                    prev_orig = segments[i - 1].get("text", "") if i > 0 else ""
                    prev_trans = completed_translations.get(i - 1, "") if i > 0 else ""
                    reason = _bad_output_reason(
                        orig_text, translated, target_lang, prev_orig, prev_trans
                    )
                    if reason:
                        log.warning(
                            "[TRANSLATE] seg=%d bad output (%s), retrying: %s",
                            i, reason, translated[:80],
                        )
                        retry_samp = dict(sampling)
                        retry_samp["temperature"] = min(sampling["temperature"] + 0.4, 1.0)

                        def _infer_retry(msgs=messages, samp=retry_samp):
                            return _model.create_chat_completion(
                                messages=msgs,
                                max_tokens=512,
                                temperature=samp["temperature"],
                                top_p=samp["top_p"],
                                repeat_penalty=samp["repeat_penalty"],
                            )

                        retry_resp = await loop.run_in_executor(None, _infer_retry)
                        retry_raw = ""
                        retry_translated = ""
                        retry_reason: str | None = reason
                        if retry_resp and "choices" in retry_resp and len(retry_resp["choices"]) > 0:
                            retry_raw = retry_resp["choices"][0].get("message", {}).get("content") or ""
                            retry_translated = quality_filters.collapse_immediate_repeats(
                                _postprocess(retry_raw)
                            )
                            retry_reason = _bad_output_reason(
                                orig_text, retry_translated, target_lang, prev_orig, prev_trans
                            )

                        if retry_translated and retry_reason is None:
                            log.info("[TRANSLATE] seg=%d retry succeeded", i)
                            translated = retry_translated
                            raw_content = retry_raw
                        else:
                            # Persistent failure: count it for review. Blank the
                            # clearly-not-a-translation classes (a refusal /
                            # off-language sentence as a subtitle is worse than
                            # an empty cue); otherwise keep the best-effort text.
                            _flagged_count += 1
                            final_reason = retry_reason or reason
                            log.warning(
                                "[TRANSLATE] seg=%d still bad (%s) after retry — flagged",
                                i, final_reason,
                            )
                            if final_reason in ("refusal", "off_language", "empty"):
                                translated = ""
                            elif retry_translated:
                                translated = retry_translated

                    translated = _fix_untranslated(orig_text, translated, vocabulary=glossary)

            log.debug(
                "[TRANSLATE] seg=%d | orig=%s | raw=%s | post=%s",
                i,
                segments[i].get("text", "")[:50],
                raw_content[:80],
                translated[:80],
            )

            completed_translations[i] = translated
            result_entry = {
                "index": i,
                "original": segments[i].get("text", ""),
                "translated": translated,
            }
            all_results.append(result_entry)

            # Feed dynamic few-shot buffer. Skip echoes and empty outputs
            # to avoid amplifying LLM failures into the next prompt.
            orig_text = segments[i].get("text", "")
            if (
                RECENT_FEW_SHOT_WINDOW > 0
                and translated
                and translated != orig_text
            ):
                recent_buffer.append({"source": orig_text, "target": translated})
                # Cap the buffer — we only read the tail, no need to grow unbounded.
                if len(recent_buffer) > RECENT_FEW_SHOT_WINDOW * 4:
                    del recent_buffer[: -RECENT_FEW_SHOT_WINDOW * 2]

            yield {
                "type": "translate_segment",
                "job_id": job_id,
                **result_entry,
            }

            progress = min(int(((i + 1) / total) * pass1_weight * 100), 99)
            yield {
                "type": "translate_progress",
                "job_id": job_id,
                "progress": progress,
                "message": f"Translating... ({i + 1}/{total} segments)",
            }
            i += 1

            # Rolling summary generation
            if i > 0 and i % SUMMARY_INTERVAL == 0:
                try:
                    # Refresh from scratch periodically to prevent drift
                    prev_summary = None if (i % SUMMARY_REFRESH == 0) else rolling_summary
                    summary_start = max(0, i - SUMMARY_INTERVAL)
                    summary_msgs = prompt_builder.build_summary_messages(
                        segments, completed_translations,
                        summary_start, i - 1,
                        prev_summary, source_lang, target_lang,
                        model_category=model_category,
                    )

                    def _infer_summary(msgs=summary_msgs):
                        return _model.create_chat_completion(
                            messages=msgs,
                            max_tokens=256,
                            temperature=0.2,
                            top_p=0.9,
                            repeat_penalty=1.0,
                        )

                    summary_resp = await loop.run_in_executor(None, _infer_summary)
                    if summary_resp and "choices" in summary_resp:
                        raw = summary_resp["choices"][0].get("message", {}).get("content") or ""
                        raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
                        if raw:
                            rolling_summary = raw
                            log.info("Rolling summary updated at segment %d: %s", i, rolling_summary[:100])
                except Exception as e:
                    log.warning("Summary generation failed at segment %d: %s", i, e)

            await asyncio.sleep(0)  # yield control

        # Note: the previous self-refinement "2-pass" (re-ask the same model
        # to refine its own draft) was removed — it was structurally incapable
        # of improving quality since the same weights produce the same bias on
        # the second pass. A real 2-pass design (pivot-language JA→EN→KO, or
        # cross-model verification) is a separate feature and will be tracked
        # as `translation_mode="pivot_2pass"` when implemented.

        # Done
        _translate_elapsed = _time.time() - _translate_start
        _repeated = sum(1 for j in range(1, len(all_results))
                        if all_results[j]["translated"] == all_results[j-1]["translated"]
                        and all_results[j]["translated"])
        log.info(
            "[TRANSLATE] Complete: %d segments in %.1fs (%.1f seg/s), repeated=%d, flagged=%d",
            len(all_results), _translate_elapsed,
            len(all_results) / _translate_elapsed if _translate_elapsed > 0 else 0,
            _repeated,
            _flagged_count,
        )
        job["state"] = TranslateJobState.DONE
        yield {
            "type": "done",
            "job_id": job_id,
            "result": json.dumps(all_results),
        }

    except Exception as e:
        job["state"] = TranslateJobState.FAILED
        yield {"type": "error", "job_id": job_id, "error": str(e)}
    finally:
        cleanup_job(job_id)
        _auto_purge_jobs()
