"""faster-whisper (CTranslate2) backend."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger(__name__)

try:
    from faster_whisper import WhisperModel
except Exception as e:  # noqa: BLE001 - any load failure -> STT off, not fatal
    # Not just ImportError: a native backend can fail to *load* (missing MSVC
    # runtime, wrong CPU ISA), which raises OSError/RuntimeError. Letting that
    # escape kills `import stt_router` and takes the whole server down with it.
    log.warning("faster_whisper unavailable, STT disabled: %s: %s", type(e).__name__, e)
    WHISPER_LOAD_ERROR: str | None = f"{type(e).__name__}: {e}"
    WhisperModel = None  # type: ignore[misc,assignment]
else:
    WHISPER_LOAD_ERROR = None

import gpu_utils

# The decoding settings every Whisper job runs with. Each one is load-bearing:
# - temperature=0.0 only: the retry ladder (higher temperatures after a failed
#   compression-ratio check) is where int8 models crashed CT2 on Windows (da27d1e).
# - condition_on_previous_text=False: one bad line must not poison the next.
# - VAD caps a segment at 15 s so subtitle cues stay readable.
TRANSCRIBE_KWARGS: dict[str, Any] = dict(
    beam_size=5,
    word_timestamps=True,
    vad_filter=True,
    vad_parameters=dict(
        max_speech_duration_s=15,
        min_silence_duration_ms=200,
        speech_pad_ms=300,
        threshold=0.3,
    ),
    condition_on_previous_text=False,
    no_speech_threshold=0.3,
    temperature=0.0,
)


class WhisperBackend:
    engine_id = "faster-whisper"
    display_name = "Whisper"

    def __init__(self) -> None:
        self._model: Any = None

    def find_model(self, model_dir: Path, model_id: str) -> Path | None:
        base = model_dir / model_id
        if (base / "model.bin").exists():
            return base
        return None

    def check_available(self) -> None:
        if WhisperModel is None:
            # "not installed" would be a lie and a wild goose chase: the package
            # is there, it just could not load. Keep the real reason and hand it
            # to the user with the failure, or they go debugging pip instead of
            # a missing DLL.
            raise RuntimeError(f"faster-whisper unavailable ({WHISPER_LOAD_ERROR})")

    def load(self, model_path: Path, aux_paths: dict[str, Path] | None = None) -> None:
        self.check_available()
        device, compute_type = gpu_utils.get_stt_device()
        self._model = WhisperModel(str(model_path), device=device, compute_type=compute_type)
        log.info("Loaded Whisper model: %s (device=%s)", model_path.name, device)

    def unload(self) -> None:
        self._model = None

    def transcribe(self, audio_path: str, language: str | None) -> tuple[Iterator[Any], Any]:
        return self._model.transcribe(audio_path, language=language, **TRANSCRIBE_KWARGS)
