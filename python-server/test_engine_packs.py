import sys

import engine_packs


def test_unset_root_is_reported(monkeypatch):
    monkeypatch.delenv("LOCALSUB_ENGINE_PACKS", raising=False)
    assert engine_packs.activate("qwen3-asr") == "LOCALSUB_ENGINE_PACKS is not set"


def test_missing_pack_is_reported_and_not_added(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALSUB_ENGINE_PACKS", str(tmp_path))
    (tmp_path / "qwen3-asr").mkdir()  # a pack dir without its marker = unfinished
    before = list(sys.path)

    assert engine_packs.activate("qwen3-asr") == "the qwen3-asr components are not installed"
    assert sys.path == before


def test_ready_pack_goes_last_on_sys_path_once(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALSUB_ENGINE_PACKS", str(tmp_path))
    d = tmp_path / "qwen3-asr"
    d.mkdir()
    (d / ".complete").write_text("hash")
    monkeypatch.setattr(sys, "path", list(sys.path))

    assert engine_packs.activate("qwen3-asr") is None
    assert engine_packs.activate("qwen3-asr") is None
    assert sys.path[-1] == str(d)
    assert sys.path.count(str(d)) == 1
