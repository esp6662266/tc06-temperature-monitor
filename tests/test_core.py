import json
import pytest
from tc06.core import CandidateWatch, ClockWatch, Outbox, make_record, parse_temperature
from tc06.worker import validate_endpoint


def test_temperature_must_have_decimal_and_one_value():
    assert parse_temperature("123.4 °C") == 123.4
    assert parse_temperature("-12.3 C") == -12.3
    for bad in ["1234", "12,3", "1.2 3.4", "O.0", "12.34", "", "nan", "9.9e3"]:
        with pytest.raises(ValueError):
            parse_temperature(bad)


def test_clock_needs_progress_and_expires_even_if_frames_keep_arriving():
    watch = ClockWatch(timeout=15)
    assert watch.update("11:00:00", 0) == "freshness_unverified"
    assert watch.update("11:00:01", 2) == "ok"
    assert watch.update("11:00:01", 18) == "stale_source"
    assert watch.update(None, 19) == "freshness_unverified"
    assert watch.update("11:00:20", 20) == "ok"
    assert watch.update("29:99:99", 21) == "freshness_unverified"


def test_invalid_reading_is_never_persisted_as_current_temperature():
    record = make_record({"status":"ocr_failed", "value_c":123.4}, "test-pc")
    assert record["value_c"] is None


def test_candidate_confirmation_vetoes_a_transient_step_but_accepts_real_high_values():
    watch = CandidateWatch()
    assert not watch.update(900, "12:00:00", 0)
    assert not watch.update(900, "12:00:00", 1)  # Same frozen source tick cannot confirm.
    assert watch.update(900.1, "12:00:01", 2)
    assert watch.accepted == 900.1  # No averaging.
    assert not watch.update(90, "12:00:02", 4)
    assert watch.update(901, "12:00:03", 6)  # A single bad low reading is dropped.
    assert not watch.update(1200, "12:00:04", 8)
    assert watch.update(1200.3, "12:00:05", 10)  # No 900/1000 C cap.
    assert watch.accepted == 1200.3
    assert not watch.update(1200.4, "12:01:00", 60)  # Long observation gap.
    watch.reset()
    assert not watch.update(1200.5, "12:01:01", 62)


def test_offline_queue_survives_restart_deduplicates_and_prioritizes_newest(tmp_path):
    path = tmp_path / "history.db"
    box = Outbox(path)
    records = [make_record({"status":"ocr_failed"}, "test-pc") for _ in range(15)]
    for record in records:
        box.add(record)
    box.add(records[0])
    box.close()
    box = Outbox(path)
    assert box.count_pending() == 15
    assert box.pending()[0]["id"] == records[-1]["id"]
    box.ack(records[-1]["id"])
    assert box.count_pending() == 14
    assert box.db.execute("select count(*) from records").fetchone()[0] == 15
    box.close()


def test_upload_endpoint_rejects_unencrypted_nonlocal_hosts_and_embedded_secrets():
    assert validate_endpoint("https://example.netlify.app/") == "https://example.netlify.app"
    assert validate_endpoint("http://127.0.0.1:8766")
    for url in ["http://example.com", "https://user:password@example.com", "https://example.com/?token=secret"]:
        with pytest.raises(ValueError):
            validate_endpoint(url)


def test_text_only_uploader_acknowledges_expired_record_without_retry(tmp_path, monkeypatch):
    import io
    import urllib.error
    from tc06.worker import Monitor
    box = Outbox(tmp_path / "history.sqlite3")
    row = make_record({"status": "ocr_failed"}, "test-pc")
    box.add(row)
    box.close()
    events = []
    def notify(event):
        events.append(event)
        monitor.stop_event.set()
    monitor = Monitor({"server_url": "https://example.netlify.app"}, tmp_path, notify)
    def expired_response(request, timeout):
        body = json.loads(request.data)
        assert list(body) == ["record"]
        raise urllib.error.HTTPError(request.full_url, 410, "Expired", {}, io.BytesIO(json.dumps({"discarded": "retention_expired", "id": row["id"]}).encode()))
    monkeypatch.setattr("urllib.request.urlopen", expired_response)
    monitor._send()
    box = Outbox(tmp_path / "history.sqlite3")
    assert box.count_pending() == 0
    assert events[0]["retention_dropped"] is True
    box.close()
