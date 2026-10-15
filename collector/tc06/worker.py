from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse
from pathlib import Path
from .capture import DeviceSource, WindowSource
from .core import Outbox, make_record, utc_now
from .ocr import Reader


def validate_endpoint(base):
    parsed = urlparse(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("서버 주소에 자격증명, 쿼리 또는 fragment를 넣지 마세요")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}):
        raise ValueError("서버는 HTTPS 주소여야 합니다 (로컬 개발만 HTTP 허용)")
    if not parsed.hostname:
        raise ValueError("서버 주소가 필요합니다")
    return base.rstrip("/")


class Monitor:
    def __init__(self, config, runtime_dir, notify):
        self.config = config
        self.base = validate_endpoint(config["server_url"])
        self.runtime = Path(runtime_dir)
        self.runtime.mkdir(parents=True, exist_ok=True)
        self.notify = notify
        self.stop_event = threading.Event()
        self.threads = []
        self.lock = threading.Lock()
        self.running = False

    def start(self):
        initialized = Outbox(self.runtime / "history.sqlite3")
        initialized.close()
        self.running = True
        for target in (self._collect, self._send):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self.threads.append(thread)

    def stop(self):
        self.stop_event.set()
        # Joining must not block the GUI; shutdown is checked by the GUI timer.

    def alive(self):
        return any(thread.is_alive() for thread in self.threads)

    def _collect(self):
        source = None
        box = None
        try:
            box = Outbox(self.runtime / "history.sqlite3")
            reader = Reader(self.config.get("tesseract_path", ""))
            next_save = time.monotonic() + 60
            saved_once = False
            while not self.stop_event.is_set():
                started = time.monotonic()
                try:
                    if source is None:
                        source = (DeviceSource(self.config.get("device_index", 0)) if self.config["source"] == "device"
                                  else WindowSource(self.config["window_title"]))
                    frame = source.read()
                    reading = reader.read(frame, getattr(source, "visible", None))
                    if time.monotonic() - started > 20:
                        reading.update(status="source_error", value_c=None)
                    roi = reading.get("roi")
                    if roi:
                        import cv2
                        x1, y1, x2, y2 = roi
                        self.notify({"crop_png": cv2.imencode(".png", frame[y1:y2, x1:x2])[1].tobytes()})
                except Exception as error:
                    logging.warning("Capture/OCR error (%s)", type(error).__name__)
                    reading = {"status": "source_error", "value_c": None, "captured_at": utc_now()}
                    if source:
                        source.close()
                        source = None
                self.notify({"reading": reading})
                now = time.monotonic()
                if now >= next_save or (not saved_once and reading.get("status") == "ok"):
                    record = make_record(reading, self.config["device_id"])
                    box.add(record)
                    self.notify({"saved_at": record["recorded_at"], "pending": box.count_pending()})
                    # Do not invent missing minute readings after a long pause.
                    next_save = now + 60
                    saved_once = True
                self.stop_event.wait(max(.1, 2 - (time.monotonic() - started)))
        except Exception as error:
            logging.error("Collector stopped (%s)", type(error).__name__)
            self.notify({"error": "수집 중단: 설정, OCR 설치 또는 로컬 저장소를 확인하세요"})
            self.stop_event.set()
        finally:
            if source:
                source.close()
            if box:
                box.close()

    def _send(self):
        box = None
        try:
            box = Outbox(self.runtime / "history.sqlite3")
            while not self.stop_event.is_set():
                pending = box.pending()
                failed = False
                # Newest first, so reconnection restores current display promptly.
                for record in pending:
                    if self.stop_event.is_set():
                        break
                    body = {"record": record}
                    try:
                        request = urllib.request.Request(
                            self.base + "/api/ingest", data=json.dumps(body).encode(),
                            headers={"Content-Type": "application/json"}, method="POST")
                        with urllib.request.urlopen(request, timeout=15) as response:
                            reply = json.load(response)
                        if reply.get("id") != record["id"] or reply.get("saved") is not True:
                            raise RuntimeError("서버 저장 확인 응답 불일치")
                        box.ack(record["id"])
                        self.notify({"uploaded_at": utc_now(), "pending": box.count_pending()})
                    except urllib.error.HTTPError as error:
                        if error.code == 410:
                            try:
                                reply = json.load(error)
                                if reply.get("discarded") == "retention_expired" and reply.get("id") == record["id"]:
                                    box.ack(record["id"])
                                    self.notify({"retention_dropped": True, "pending": box.count_pending()})
                                    continue
                            except (ValueError, OSError):
                                pass
                        self.notify({"network_error": "서버 전송 실패: PC에 보관 중, 자동 재시도", "pending": box.count_pending()})
                        failed = True
                        break
                    except Exception as error:
                        logging.warning("Upload failed (%s); record remains pending", type(error).__name__)
                        self.notify({"network_error": "서버 전송 실패: PC에 보관 중, 자동 재시도", "pending": box.count_pending()})
                        failed = True
                        break
                self.stop_event.wait(15 if failed else 3)
        except Exception as error:
            logging.error("Uploader stopped (%s)", type(error).__name__)
            self.notify({"error": "전송 작업 중단: 로컬 저장소 또는 설정을 확인하세요"})
            self.stop_event.set()
        finally:
            if box:
                box.close()
