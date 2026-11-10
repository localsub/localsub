"""Qwen3-ASR backend (transformers), with the Qwen3 forced aligner for timing.

Flow per file (docs/design/qwen3-asr-stt-engine.md section 3.1):
  1. Silero VAD splits speech (faster_whisper.vad, the Whisper path's settings).
  2. Qwen3-ASR transcribes each chunk; the first chunks decide the language.
  3. The forced aligner times every word; subtitle_segmenter turns the words
     into cues, with text cut from the transcript.

The aligner covers 11 languages. For any other language Qwen is refused with
a plain reason rather than producing 15-second cues (design decision 8-1):
the user is told to use a Whisper model for that language.

Nothing here imports torch or qwen_asr at module import: those live in the
on-demand engine pack (engine_packs.py), which may not be installed. A failed
import is reported by check_available() with the real reason.
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

import engine_packs
import subtitle_segmenter

log = logging.getLogger(__name__)

ENGINE_ID = "qwen3-asr"

# Qwen3-ASR language names <-> ISO 639-1 (what the app and translation use).
QWEN_LANGUAGES: dict[str, str] = {
    "Chinese": "zh", "English": "en", "Cantonese": "yue", "Arabic": "ar",
    "German": "de", "French": "fr", "Spanish": "es", "Portuguese": "pt",
    "Indonesian": "id", "Italian": "it", "Korean": "ko", "Russian": "ru",
    "Thai": "th", "Vietnamese": "vi", "Japanese": "ja", "Turkish": "tr",
    "Hindi": "hi", "Malay": "ms", "Dutch": "nl", "Swedish": "sv",
    "Danish": "da", "Finnish": "fi", "Polish": "pl", "Czech": "cs",
    "Filipino": "tl", "Persian": "fa", "Greek": "el", "Romanian": "ro",
    "Hungarian": "hu", "Macedonian": "mk",
}
ISO_TO_QWEN = {v: k for k, v in QWEN_LANGUAGES.items()}
# Languages Qwen3-ForcedAligner-0.6B can time (its model card).
ALIGNER_LANGUAGES = {"zh", "yue", "en", "ko", "ja", "fr", "de", "it", "es", "pt", "ru"}

UNSUPPORTED_CODE = "stt_language_unsupported_by_engine"

# Same VAD settings as the Whisper path (stt_backend_whisper.TRANSCRIBE_KWARGS),
# so both engines produce speech chunks of the same shape.
VAD_PARAMS = dict(max_speech_duration_s=15, min_silence_duration_ms=200, speech_pad_ms=300, threshold=0.3)
SAMPLE_RATE = 16000
# Chunks decoded per model call: large enough to keep the GPU busy, small
# enough that cancel (checked between yielded cues) answers within seconds.
BATCH = 4
# Speech (seconds) the language vote looks at before deciding.
DETECT_SECONDS = 20.0


class LanguageUnsupportedError(RuntimeError):
    """Qwen cannot time subtitles for this language. The message starts with
    UNSUPPORTED_CODE so the app can show its own localized explanation."""

    def __init__(self, code: str | None, name: str):
        self.language = code
        super().__init__(
            f"{UNSUPPORTED_CODE}: Qwen3-ASR cannot time subtitles for {name}"
            f"{f' ({code})' if code else ''}. Transcribe this language with a Whisper model."
        )


def _name(code: str | None) -> str:
    return ISO_TO_QWEN.get(code or "", code or "this language")


def check_language(code: str | None) -> None:
    """Refuse a language the aligner cannot time. None (= detect) passes."""
    if code is not None and code not in ALIGNER_LANGUAGES:
        raise LanguageUnsupportedError(code, _name(code))


def vote_language(chunks: list[tuple[str | None, float]]) -> str | None:
    """The language with the most speech among (iso code, seconds) pairs."""
    total: dict[str, float] = {}
    for code, seconds in chunks:
        if code:
            total[code] = total.get(code, 0.0) + seconds
    return max(total, key=total.get) if total else None


def _load_qwen() -> tuple[Any, Any, Any]:
    """(torch, Qwen3ASRModel, Qwen3ForcedAligner). Imported lazily: they come
    from the engine pack."""
    import torch
    from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner

    return torch, Qwen3ASRModel, Qwen3ForcedAligner


def _decode_audio(path: str):
    from faster_whisper.audio import decode_audio

    return decode_audio(path, sampling_rate=SAMPLE_RATE)


def _speech_spans(audio) -> list[dict]:
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    return get_speech_timestamps(audio, VadOptions(**VAD_PARAMS))


class QwenBackend:
    engine_id = ENGINE_ID
    display_name = "Qwen3-ASR"

    def __init__(self) -> None:
        self._asr: Any = None
        self._aligner: Any = None

    def find_model(self, model_dir: Path, model_id: str) -> Path | None:
        # Hugging Face transformers layout: config + safetensors (possibly sharded).
        base = model_dir / model_id
        if (base / "config.json").is_file() and any(base.glob("*.safetensors")):
            return base
        return None

    def check_available(self) -> None:
        reason = engine_packs.activate(ENGINE_ID)
        if reason is None:
            try:
                _load_qwen()
            except Exception as e:  # noqa: BLE001 - any load failure is the reason
                # Not just ImportError: torch's CUDA DLLs can fail to load.
                reason = f"{type(e).__name__}: {e}"
        if reason is not None:
            raise RuntimeError(f"Qwen3-ASR unavailable ({reason})")

    def load(self, model_path: Path, aux_paths: dict[str, Path] | None = None) -> None:
        aligner_path = (aux_paths or {}).get("aligner")
        if aligner_path is None:
            raise FileNotFoundError("Qwen3-ASR needs its aligner model, which is not installed")
        self.check_available()
        torch, Qwen3ASRModel, Qwen3ForcedAligner = _load_qwen()
        if not torch.cuda.is_available():
            raise RuntimeError("Qwen3-ASR needs an NVIDIA GPU")
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        kwargs = dict(dtype=dtype, device_map="cuda:0")
        self._asr = Qwen3ASRModel.from_pretrained(
            str(model_path), max_inference_batch_size=BATCH, max_new_tokens=256, **kwargs
        )
        self._aligner = Qwen3ForcedAligner.from_pretrained(str(aligner_path), **kwargs)
        log.info("Loaded Qwen3-ASR model: %s + aligner %s (dtype=%s)", model_path.name, aligner_path.name, dtype)

    def unload(self) -> None:
        self._asr = None
        self._aligner = None

    def transcribe(self, audio_path: str, language: str | None) -> tuple[Iterator[Any], Any]:
        check_language(language)
        audio = _decode_audio(audio_path)
        spans = _speech_spans(audio)
        info = SimpleNamespace(duration=len(audio) / SAMPLE_RATE, language=language)
        return self._cues(audio, spans, language, info), info

    def _cues(self, audio, spans: list[dict], forced: str | None, info) -> Iterator[Any]:
        chunks = [(audio[s["start"]:s["end"]], SAMPLE_RATE) for s in spans]
        offsets = [s["start"] / SAMPLE_RATE for s in spans]
        qwen_forced = ISO_TO_QWEN.get(forced) if forced else None
        language = forced
        votes: list[tuple[str | None, float]] = []
        pending: list[tuple[int, Any]] = []  # chunks transcribed before the language is known

        for b in range(0, len(chunks), BATCH):
            idx = list(range(b, min(b + BATCH, len(chunks))))
            outs = self._asr.transcribe(audio=[chunks[i] for i in idx], language=qwen_forced)
            for i, out in zip(idx, outs):
                if language is None and out.text.strip():
                    votes.append((QWEN_LANGUAGES.get(out.language), len(chunks[i][0]) / SAMPLE_RATE))
                pending.append((i, out))
            if language is None:
                heard = sum(s for _, s in votes)
                if heard < DETECT_SECONDS and idx[-1] + 1 < len(chunks):
                    continue  # keep listening before deciding
                language = vote_language(votes)
                if language is None:
                    continue  # silence so far
                check_language(language)
                info.language = language
            yield from self._align(pending, chunks, offsets, language)
            pending = []
        if pending and language is not None:
            yield from self._align(pending, chunks, offsets, language)

    def _align(self, pending, chunks, offsets, language: str) -> Iterator[Any]:
        todo = [(i, out) for i, out in pending if out.text.strip()]
        if not todo:
            return
        def align_as(out) -> str:
            # A chunk in another language the aligner knows (a code-switched
            # line) is timed in its own language; anything else in the file's.
            own = QWEN_LANGUAGES.get(out.language)
            return ISO_TO_QWEN[own if own in ALIGNER_LANGUAGES else language]

        results = self._aligner.align(
            audio=[chunks[i] for i, _ in todo],
            text=[out.text for _, out in todo],
            language=[align_as(out) for _, out in todo],
        )
        for (i, out), result in zip(todo, results):
            words = subtitle_segmenter.words_from(result.items, offset=offsets[i])
            for cue in subtitle_segmenter.segment(out.text, words):
                yield SimpleNamespace(start=cue.start, end=cue.end, text=cue.text)
