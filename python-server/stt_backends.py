"""STT engines: the contract every engine implements, and the engine registry.

`stt_engine` owns everything that does not depend on the engine: jobs, the
cancel flag, long-file chunking, ffmpeg extraction and the quiet-speech boost,
the reported transcript language, and the SSE event shapes. A backend only
finds, loads and runs one kind of model. Backends live in flat
`stt_backend_<name>.py` modules next to this one, because the app bundles
`python-server/*` without subdirectories.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterator, Protocol


class SttSegment(Protocol):
    """One transcribed line. Times are seconds from the start of the audio file
    the backend was given (the orchestrator adds the chunk offset)."""

    start: float
    end: float
    text: str


class SttInfo(Protocol):
    """Facts about one `transcribe` call.

    `duration` (seconds) drives progress and may be None or 0 when unknown.
    `language` is read only after the segment iterator is exhausted, so a
    backend that detects the language while decoding may fill it in late.
    """

    duration: float | None
    language: str | None


class SttBackend(Protocol):
    engine_id: str
    # Shown to the user in progress and error messages ("Loading Whisper model...").
    display_name: str

    def find_model(self, model_dir: Path, model_id: str) -> Path | None:
        """The directory holding `model_id`'s files if they are all present, else None."""
        ...

    def check_available(self) -> None:
        """Raise RuntimeError naming the real reason when the engine's runtime
        could not be imported ("not installed" is usually false: the package is
        there and a DLL failed to load)."""
        ...

    def load(self, model_path: Path, aux_paths: dict[str, Path] | None = None) -> None:
        """Load the model from a directory `find_model` returned. `aux_paths`
        maps a helper's role ("aligner") to its directory."""
        ...

    def unload(self) -> None:
        """Drop the model. The orchestrator then runs gc and empties the CUDA cache."""
        ...

    def transcribe(
        self, audio_path: str, language: str | None
    ) -> tuple[Iterator[SttSegment], SttInfo]:
        """Start transcribing `audio_path` (16 kHz mono WAV or any file ffmpeg
        can read). `language` None means detect it.

        The iterator must be lazy: the orchestrator pulls one segment at a time
        off the event loop and checks the cancel flag between segments.
        """
        ...


from stt_backend_qwen import QwenBackend  # noqa: E402 - needs the Protocols above
from stt_backend_whisper import WhisperBackend  # noqa: E402

DEFAULT_ENGINE = "faster-whisper"

_ENGINES: dict[str, Callable[[], SttBackend]] = {
    WhisperBackend.engine_id: WhisperBackend,
    QwenBackend.engine_id: QwenBackend,
}


def create_backend(engine: str = DEFAULT_ENGINE) -> SttBackend:
    try:
        factory = _ENGINES[engine]
    except KeyError:
        raise ValueError(f"Unknown STT engine: {engine}") from None
    return factory()
