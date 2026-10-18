"""Build the fixed Korean female number lexicon on macOS; not needed at runtime."""
from pathlib import Path
import json
import subprocess
import tempfile
import argparse

ROOT = Path(__file__).resolve().parents[1]
WORDS = {"intro": "현재 온도는", "fallback": "수신 이력이 없습니다. 기본 표시값은", "minus": "영하", "0": "영", "1": "일", "2": "이", "3": "삼", "4": "사", "5": "오", "6": "육", "7": "칠", "8": "팔", "9": "구", "10": "십", "100": "백", "1000": "천", "point": "점", "end": "도입니다"}
parser = argparse.ArgumentParser()
parser.add_argument('--only', choices=list(WORDS))
args = parser.parse_args()
out = ROOT / "web" / "voice"
out.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="tc06-number-voice-") as temporary:
    for key, text in WORDS.items():
        if args.only and key != args.only:
            continue
        raw = Path(temporary) / (key + ".aiff")
        subprocess.run(["/usr/bin/say", "-v", "Yuna", "-r", "175", "-o", str(raw), text], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", "silenceremove=start_periods=1:start_duration=0.01:start_threshold=-45dB:stop_periods=-1:stop_duration=0.06:stop_threshold=-45dB,apad=pad_dur=0.035", "-ar", "24000", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k", str(out / (key + ".mp3"))], check=True)
manifest = {"version": 1, "voice": "Yuna", "language": "ko-KR", "gender": "female", "words": WORDS,
            "bytes": sum((out / (key + ".mp3")).stat().st_size for key in WORDS)}
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", "utf-8")
print(f"Fixed voice lexicon: {len(WORDS)} fragments, {manifest['bytes']} bytes")
