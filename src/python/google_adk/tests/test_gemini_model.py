"""The Gemini model setting (common/gemini_model.py), which the Python ADK and Strands frameworks use."""
from common.gemini_model import DEFAULT_GEMINI_MODEL, gemini_model


def test_defaults_without_gemini_model(monkeypatch):
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    assert gemini_model() == DEFAULT_GEMINI_MODEL
    monkeypatch.setenv("GEMINI_MODEL", "")
    assert gemini_model() == DEFAULT_GEMINI_MODEL


def test_reads_gemini_model(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.8-pro")
    assert gemini_model() == "gemini-3.8-pro"
