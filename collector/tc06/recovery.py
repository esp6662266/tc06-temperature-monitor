"""Retry scheduling and bounded, local-only failure evidence."""
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import time
import uuid

VERSION = "0.6.0"
STATUS_TEXT = {
    "ok": "정상 판독", "source_error": "영상 캡처 실패", "window_missing": "창 없음·최소화",
    "ocr_timeout": "판독 시간 초과", "ocr_failed": "숫자 판독 실패",
    "anchor_missing": "TC-06 위치 미검출", "ambiguous_anchor": "TC-06 위치 중복",
    "occluded": "판독 영역 가림", "low_confidence": "판독 신뢰도 부족",
    "value_suspect": "숫자 추가 확인", "freshness_unverified": "원본 시계 확인 중",
    "stale_source": "원본 화면 정지 의심",
}


class Recovery:
    def __init__(self, now=None):
        now = time.monotonic() if now is None else now
        self.next_save = now + 60
        self.saved_once = False
        self.failed_at = None
        self.attempts = 0
        self.failed_saved = False

    def observe(self, reading, now):
        good = reading.get("status") == "ok"
        recovering = good and self.failed_at is not None
        if good:
            self.failed_at, self.attempts = None, 0
        else:
            if self.failed_at is None:
                self.failed_at = now
            self.attempts += 1
        save = now >= self.next_save or (good and (not self.saved_once or (recovering and self.failed_saved)))
        if save:
            self.saved_once, self.next_save = True, now + 60
            self.failed_saved = not good
        failed_seconds = 0 if good else max(0, now - self.failed_at)
        return {"save": save, "recovered": recovering, "retry_seconds": 2 if good else (3 if failed_seconds < 30 else 10),
                "attempts": self.attempts, "failed_seconds": round(failed_seconds)}


class Diagnostics:
    """Never save full frames. At most 24 cropped images / 5 MB, plus rotated JSONL."""
    def __init__(self, runtime):
        self.directory = Path(runtime) / "diagnostics"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.logger = logging.Logger("tc06-diagnostics")
        self.handler = RotatingFileHandler(self.directory / "failures.jsonl", maxBytes=300_000, backupCount=2, encoding="utf-8")
        self.logger.addHandler(self.handler)
        self.previous = None
        self.logged_at = self.image_at = float("-inf")

    def record(self, reading, frame=None, now=None):
        now = time.monotonic() if now is None else now
        status = reading["status"]
        changed = status != self.previous
        if status == "ok" and self.previous in (None, "ok"):
            self.previous = status
            return
        if not changed and now - self.logged_at < 30:
            return
        self.previous, self.logged_at = status, now
        item = {key: reading[key] for key in ("captured_at", "status", "confidence", "source_clock", "verification",
                "ocr_candidates", "duration_ms", "input_size", "error_type") if key in reading}
        item["version"] = VERSION
        roi = reading.get("roi")
        if status != "ok" and frame is not None and roi and now - self.image_at >= 30:
            import cv2
            x1, y1, x2, y2 = roi
            crop = frame[max(0, y1):min(frame.shape[0], y2), max(0, x1):min(frame.shape[1], x2)]
            if crop.size:
                ratio = min(1, 640 / crop.shape[1], 160 / crop.shape[0])
                crop = cv2.resize(crop, None, fx=ratio, fy=ratio)
                image = self.directory / f"crop-{time.time_ns()}-{uuid.uuid4().hex}.png"
                if cv2.imwrite(str(image), crop):
                    self.image_at = now
                    item["crop"] = image.name
        images = sorted(self.directory.glob("crop-*.png"))
        size = sum(path.stat().st_size for path in images)
        while images and (len(images) > 24 or size > 5_000_000):
            path = images.pop(0)
            size -= path.stat().st_size
            path.unlink(missing_ok=True)
        self.logger.warning(json.dumps(item, ensure_ascii=False))

    def close(self):
        self.handler.close()


def display_reading(reading, last_good, now):
    """GUI fallback only; never turn the retained number into a new record."""
    from datetime import datetime
    if reading["status"] == "ok":
        return f"{reading['value_c']:.1f} ℃"
    if last_good:
        age = max(0, (now - datetime.fromisoformat(last_good["captured_at"])).total_seconds())
        if age < 30 * 86400:
            return f"{last_good['value_c']:.1f} ℃ · 마지막 정상값 · {int(age // 60)}분 전"
    return "— ℃"
