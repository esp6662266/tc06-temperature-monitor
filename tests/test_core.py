import json
import pytest
from tc06.core import ClockWatch, Outbox, make_record, parse_temperature
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
