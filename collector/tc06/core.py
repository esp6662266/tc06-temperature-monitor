from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
import time
import uuid
from pathlib import Path


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def parse_temperature(text):
    cleaned = re.sub(r"[\s°Cc℃]", "", text)
    if not re.fullmatch(r"-?\d{1,4}\.\d", cleaned):
        raise ValueError("A single signed decimal with exactly one decimal place is required")
    return float(cleaned)


class ClockWatch:
    """Requires a progressing source clock, not a PC-generated overlay."""
    def __init__(self, timeout=15):
        self.timeout = timeout
        self.previous = None
        self.changed_at = None
        self.progress_seen = False

    def update(self, text, now=None):
        now = time.monotonic() if now is None else now
        if not text or not re.fullmatch(r"\d{1,2}:\d{2}:\d{2}", text):
            return "freshness_unverified"
        try:
            dt.datetime.strptime(text, "%H:%M:%S")
        except ValueError:
            return "freshness_unverified"
        if self.previous is None:
            self.previous, self.changed_at = text, now
        elif text != self.previous:
            self.progress_seen = True
            self.previous, self.changed_at = text, now
        if now - self.changed_at > self.timeout:
            return "stale_source"
        return "ok" if self.progress_seen else "freshness_unverified"


class CandidateWatch:
    """Confirm startup/recovery and abrupt changes; never clamp or average values.

    The 5 C / 2% band triggers an extra observation, not a physical rate limit.
    A sustained step outside the band can be accepted on the next source tick.
    """
    def __init__(self, timeout=15):
        self.timeout = timeout
        self.reset()

    def reset(self):
        self.accepted = self.pending = self.pending_clock = self.seen_at = None

    @staticmethod
    def near(left, right):
        return abs(left - right) <= max(5.0, abs(right) * .02)

    def update(self, value, source_clock, now=None):
        now = time.monotonic() if now is None else now
        if self.seen_at is not None and now - self.seen_at > self.timeout:
            self.reset()
        self.seen_at = now
        if self.accepted is not None and self.near(value, self.accepted):
            self.accepted, self.pending, self.pending_clock = value, None, None
            return True
        if self.pending is not None and source_clock != self.pending_clock and self.near(value, self.pending):
            self.accepted, self.pending, self.pending_clock = value, None, None
            return True
        self.pending, self.pending_clock = value, source_clock
        return False


def make_record(reading, device_id):
    status = reading.get("status", "source_error")
    return {
        "id": str(uuid.uuid4()), "asset": "TC-06", "device_id": device_id,
        "captured_at": reading.get("captured_at", utc_now()), "recorded_at": utc_now(),
        "status": status, "value_c": reading.get("value_c") if status == "ok" else None,
        "source_clock": reading.get("source_clock"),
        "confidence": reading.get("confidence", 0),
    }


class Outbox:
    """Durable local history and retry queue. Acknowledged rows remain exportable."""
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)")
        self.db.commit()

    def add(self, record):
        self.db.execute("INSERT OR IGNORE INTO records(id,payload) VALUES(?,?)", (record["id"], json.dumps(record)))
        self.db.commit()

    def pending(self, limit=10):
        rows = self.db.execute("SELECT payload FROM records WHERE sent=0 ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def ack(self, record_id):
        self.db.execute("UPDATE records SET sent=1 WHERE id=?", (record_id,))
        self.db.commit()

    def count_pending(self):
        return self.db.execute("SELECT count(*) FROM records WHERE sent=0").fetchone()[0]

    def last_good(self, device_id):
        row = self.db.execute("SELECT payload FROM records WHERE json_extract(payload, '$.status')='ok' "
            "AND json_extract(payload, '$.device_id')=? ORDER BY json_extract(payload, '$.captured_at') DESC LIMIT 1", (device_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def close(self):
        self.db.close()
