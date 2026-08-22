"""Native-extension import guards must survive a failed DLL load.

Each engine imports its native backend (llama_cpp, faster_whisper,
onnxruntime) behind a try/except so a machine without that backend still
serves the features it *can* run. The guard has to cover a **failed load**,
not just a missing package.

llama_cpp turns a ctypes.CDLL failure into `RuntimeError` and a missing
binary into `FileNotFoundError` (llama_cpp/_ctypes_extensions.py:69,71).
Neither is an ImportError, so an `except ImportError` guard lets them escape,
`import translate_router` fails, and main.py dies before `uvicorn.run()` --
the whole server is gone because one optional backend could not load.

Observed on a fresh Windows PC with no MSVC C++ runtime (llama.dll imports
MSVCP140.dll, which the bundled embeddable CPython does not ship):
server.log stopped at "Server starting" and the port was never bound.
"""

import importlib
import importlib.abc
import importlib.util
import sys

import pytest


class _FailingLoader(importlib.abc.Loader):
    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def create_module(self, spec):
        raise self._exc

    def exec_module(self, module):  # pragma: no cover - never reached
        raise self._exc


class _FailingFinder(importlib.abc.MetaPathFinder):
    """Makes `target` (and its submodules) raise `exc` on import."""

    def __init__(self, target: str, exc: BaseException) -> None:
        self._target = target
        self._exc = exc

    def find_spec(self, fullname, path=None, target=None):
        if fullname == self._target or fullname.startswith(self._target + "."):
            return importlib.util.spec_from_loader(fullname, _FailingLoader(self._exc))
        return None


def _reimport_with_failing_backend(engine: str, backend: str, exc: BaseException):
    """Import `engine` fresh while `backend` fails to load with `exc`."""
    finder = _FailingFinder(backend, exc)
    saved = {
        name: mod
        for name, mod in sys.modules.items()
        if name == engine or name == backend or name.startswith(backend + ".")
    }
    for name in saved:
        del sys.modules[name]
    sys.meta_path.insert(0, finder)
    try:
        return importlib.import_module(engine)
    finally:
        sys.meta_path.remove(finder)
        for name in list(sys.modules):
            if name == engine or name == backend or name.startswith(backend + "."):
                del sys.modules[name]
        sys.modules.update(saved)


# (engine module, native backend, attr set to None, module var holding the reason)
GUARDED = [
    ("llm_engine", "llama_cpp", "Llama", "LLAMA_LOAD_ERROR"),
    ("stt_engine", "faster_whisper", "WhisperModel", "WHISPER_LOAD_ERROR"),
    ("diarization_engine", "onnxruntime", "ort", "ORT_LOAD_ERROR"),
]

# What a failed native load actually raises. RuntimeError is llama_cpp's
# wrapper around a ctypes.CDLL failure; FileNotFoundError is its missing-binary
# path; OSError is what a raw ctypes.CDLL / DLL-load failure raises.
LOAD_FAILURES = [
    RuntimeError("Failed to load shared library 'llama.dll': [WinError 126]"),
    FileNotFoundError("Shared library with base name 'llama' not found"),
    OSError("[WinError 126] The specified module could not be found"),
]


@pytest.mark.parametrize(
    "engine,backend,attr,reason_var", GUARDED, ids=[g[0] for g in GUARDED]
)
@pytest.mark.parametrize("exc", LOAD_FAILURES, ids=lambda e: type(e).__name__)
def test_engine_survives_backend_load_failure(engine, backend, attr, reason_var, exc):
    """A backend that fails to load must disable the feature, not kill import."""
    mod = _reimport_with_failing_backend(engine, backend, exc)
    assert getattr(mod, attr) is None, (
        f"{engine}.{attr} should be None when {backend} fails to load"
    )


@pytest.mark.parametrize(
    "engine,backend,attr,reason_var", GUARDED, ids=[g[0] for g in GUARDED]
)
def test_engine_keeps_the_load_failure_reason(engine, backend, attr, reason_var):
    """The reason has to survive to the job error the user actually sees.

    A bare "X is not installed" is false here -- the package is installed and
    only failed to load -- and it sends whoever reads it to debug pip instead
    of the missing MSVC runtime that actually broke the DLL.
    """
    exc = RuntimeError("Failed to load shared library 'llama.dll': [WinError 126]")
    mod = _reimport_with_failing_backend(engine, backend, exc)

    reason = getattr(mod, reason_var)
    assert reason is not None, f"{engine}.{reason_var} must record why {backend} failed"
    assert "RuntimeError" in reason and "WinError 126" in reason, reason
    assert "not installed" not in reason.lower()
