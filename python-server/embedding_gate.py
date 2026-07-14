"""Semantic gate: catch LLM output that is not a translation of the source by
cross-lingual embedding similarity — the residual the structural filters in
``quality_filters`` cannot reach (a short refusal phrased in the target
language, e.g. KO "번역할 수 없습니다", is structurally a normal line but is
semantically unrelated to the source).

Runs a small multilingual sentence-embedding model
(paraphrase-multilingual-MiniLM-L12-v2, ONNX) via the onnxruntime + tokenizers
already in the environment — no extra dependency. The ~250 MB model is
downloaded on demand and sha256-verified into %APPDATA%/LocalSub/embedding-model.

Everything degrades gracefully: if onnxruntime/tokenizers are missing, the
download fails, or the gate is disabled, ``semantic_mismatch`` returns False and
translation proceeds on the structural filters alone.
"""
import hashlib
import logging
import os
import urllib.request

log = logging.getLogger(__name__)

# Translations below this cosine similarity to their source are treated as
# "not a translation". Calibrated on real ja→ko data (paraphrase-multilingual-
# MiniLM): genuine pairs mean ~0.74, refusals mean ~0.20. At 0.45 the gate caught
# ~39/40 refusals at ~5% false flags. A false flag is cheap and non-destructive —
# "low_similarity" is only retried + flagged, never blanked — so we favour recall.
# Residual miss: a verbose target-language refusal that name-drops translation
# words can score ~0.42 and slip through. Tune via LOCALSUB_EMBED_THRESHOLD.
SIMILARITY_THRESHOLD = float(os.environ.get("LOCALSUB_EMBED_THRESHOLD", "0.45"))

# Only judge substantive lines — short interjections embed noisily and are
# never refusals worth catching.
_MIN_CHARS = 4

_MODEL_REPO = "qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q"
_COMMIT = "faf4aa4225822f3bc6376869cb1164e8e3feedd0"


def _hf_url(name: str) -> str:
    return f"https://huggingface.co/{_MODEL_REPO}/resolve/{_COMMIT}/{name}"


# (filename, sha256, size) — pinned to the commit above.
_ASSETS = [
    ("model_optimized.onnx",
     "634d0f66c29dc934c8fa72b8a4fe91dd4d420a22f1d82a241058d4316e659a99", 235052644),
    ("tokenizer.json",
     "fa685fc160bbdbab64058d4fc91b60e62d207e8dc60b9af5c002c5ab946ded00", 17083009),
]


def _model_dir() -> str:
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "LocalSub", "embedding-model")


# Lazy singletons. _state: None=not tried, "ready", "unavailable".
_state: str | None = None
_session = None
_tokenizer = None
_input_names: set[str] = set()


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download_verified(name: str, sha256: str, dest: str) -> None:
    """Download a pinned asset and verify its sha256, atomically."""
    tmp = dest + ".part"
    with urllib.request.urlopen(_hf_url(name), timeout=60) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    got = _sha256(tmp)
    if got != sha256:
        os.remove(tmp)
        raise ValueError(f"sha256 mismatch for {name}: expected {sha256}, got {got}")
    os.replace(tmp, dest)


def _ensure_assets() -> str:
    """Make sure model files exist & verify; download missing ones. Returns dir."""
    d = _model_dir()
    os.makedirs(d, exist_ok=True)
    for name, sha, _size in _ASSETS:
        path = os.path.join(d, name)
        if os.path.exists(path) and _sha256(path) == sha:
            continue
        log.info("[embed] downloading %s ...", name)
        _download_verified(name, sha, path)
    return d


def _load() -> bool:
    """Lazily download + load the model. Sets _state; returns True if ready."""
    global _state, _session, _tokenizer, _input_names
    if _state is not None:
        return _state == "ready"
    if os.environ.get("LOCALSUB_DISABLE_EMBED_GATE"):
        _state = "unavailable"
        return False
    try:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        d = _ensure_assets()
        _tokenizer = Tokenizer.from_file(os.path.join(d, "tokenizer.json"))
        _tokenizer.enable_truncation(max_length=256)
        _tokenizer.enable_padding()
        _session = ort.InferenceSession(
            os.path.join(d, "model_optimized.onnx"),
            providers=["CPUExecutionProvider"],
        )
        _input_names = {i.name for i in _session.get_inputs()}
        _state = "ready"
        log.info("[embed] semantic gate ready (threshold=%.2f)", SIMILARITY_THRESHOLD)
        return True
    except Exception as e:  # noqa: BLE001 - any failure -> gate disabled, not fatal
        log.warning("[embed] semantic gate unavailable, using structural filters only: %s", e)
        _state = "unavailable"
        return False


def warm() -> bool:
    """Best-effort eager init so the (one-time) download happens before the
    translation loop rather than mid-segment. Safe to call repeatedly."""
    return _load()


def is_available() -> bool:
    return _load()


def _embed(texts: list[str]):
    import numpy as np

    encs = _tokenizer.encode_batch(texts)
    ids = np.array([e.ids for e in encs], dtype=np.int64)
    mask = np.array([e.attention_mask for e in encs], dtype=np.int64)
    feed = {}
    if "input_ids" in _input_names:
        feed["input_ids"] = ids
    if "attention_mask" in _input_names:
        feed["attention_mask"] = mask
    if "token_type_ids" in _input_names:
        feed["token_type_ids"] = np.zeros_like(ids)
    out = _session.run(None, feed)[0]
    if out.ndim == 3:  # last_hidden_state -> mean pool over real tokens
        m = mask[..., None].astype(np.float32)
        emb = (out * m).sum(1) / np.maximum(m.sum(1), 1e-9)
    else:
        emb = out
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9
    return emb


def similarity(a: str, b: str) -> float | None:
    """Cosine similarity of two texts, or None if the gate is unavailable."""
    if not _load():
        return None
    try:
        e = _embed([a, b])
        return float(e[0] @ e[1])
    except Exception as e:  # noqa: BLE001
        log.warning("[embed] similarity failed: %s", e)
        return None


def semantic_mismatch(source: str, translation: str, threshold: float | None = None) -> bool:
    """True if ``translation`` is semantically unrelated to ``source`` — i.e.
    likely a refusal / non-translation that slipped past the structural filters.

    Returns False (don't flag) when the gate is unavailable or the texts are too
    short to judge, so callers can rely on it being conservative.
    """
    s = (source or "").strip()
    t = (translation or "").strip()
    if len(s) < _MIN_CHARS or len(t) < _MIN_CHARS:
        return False
    sim = similarity(s, t)
    if sim is None:
        return False
    return sim < (SIMILARITY_THRESHOLD if threshold is None else threshold)
