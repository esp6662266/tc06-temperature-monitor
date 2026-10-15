"""Locate the private OCR runtime beside an installed executable."""
from pathlib import Path
import os
import shutil
import sys


def bundled_ocr():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "ocr" / "tesseract.exe"
    return None


def resolve_ocr(configured=""):
    bundled = bundled_ocr()
    if bundled is not None:
        if not bundled.is_file() or not (bundled.parent / "tessdata" / "eng.traineddata").is_file():
            raise RuntimeError("내장 OCR 파일이 없습니다. 설치파일로 다시 설치해 주세요.")
        # Never depend on another PC's saved absolute path or TESSDATA_PREFIX.
        os.environ["TESSDATA_PREFIX"] = str(bundled.parent / "tessdata")
        return str(bundled)
    if configured and Path(configured).is_file():
        return str(Path(configured).resolve())
    found = shutil.which("tesseract")
    if found:
        return found
    system = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe"
    if system.is_file():
        return str(system)
    if configured:
        raise RuntimeError("지정한 OCR 파일을 찾을 수 없습니다. 내장 설치판을 사용하거나 경로를 확인해 주세요.")
    raise RuntimeError("Tesseract를 찾을 수 없습니다. 내장 설치판을 사용해 주세요.")
