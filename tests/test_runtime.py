import sys
import pytest
from tc06.runtime import resolve_ocr


def test_installed_runtime_ignores_old_computer_paths_and_external_data(tmp_path, monkeypatch):
    exe = tmp_path / "App" / "TC06Monitor.exe"
    ocr = exe.parent / "ocr" / "tesseract.exe"
    data = ocr.parent / "tessdata" / "eng.traineddata"
    data.parent.mkdir(parents=True)
    ocr.write_bytes(b"synthetic file marker; not executable")
    data.write_bytes(b"synthetic data marker")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    monkeypatch.setenv("TESSDATA_PREFIX", "another-PC-folder")
    assert resolve_ocr("C:\\missing-old-PC\\tesseract.exe") == str(ocr)
    import os
    assert os.environ["TESSDATA_PREFIX"] == str(data.parent)


def test_incomplete_install_does_not_silently_use_external_tesseract(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "TC06Monitor.exe"))
    with pytest.raises(RuntimeError, match="내장 OCR"):
        resolve_ocr()
