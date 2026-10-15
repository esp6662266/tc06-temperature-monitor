import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

NOTICE = "온도 정보가 갱신되지 않았습니다. 현장 화면을 확인해 주세요."


def speech_text(record):
    if record["status"] != "ok":
        return "온도 정보를 판독할 수 없습니다. 현장 화면을 확인해 주세요."
    return f"현재 온도는 {record['value_c']:.1f} 도입니다."


def synthesize(text, cache_dir):
    if os.name != "nt":
        raise RuntimeError("여성 음성 생성은 실제 Windows에서 확인해야 합니다")
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / (hashlib.sha256(text.encode()).hexdigest() + ".wav")
    if not path.exists():
        root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
        script = root / "speech.ps1"
        process = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(script)],
            input=json.dumps({"text": text, "path": str(path)}), text=True,
            encoding="utf-8", capture_output=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if process.returncode != 0:
            # Do not persist possibly partial output.
            path.unlink(missing_ok=True)
            raise RuntimeError("한국어 여성 TTS 생성 실패. Windows 언어/음성 패키지와 PowerShell 정책을 확인하세요")
    data = path.read_bytes()
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        path.unlink(missing_ok=True)
        raise RuntimeError("잘못된 음성 파일")
    return base64.b64encode(data).decode("ascii")
