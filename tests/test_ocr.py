import cv2
import numpy as np
import pytest
from tc06.ocr import Reader, find_anchors, read_number, number_images, matches_layout


def fixture_frame(value="123.4", tag="TC-06", shift=0, width=1280, clock="12:34:56"):
    # Synthetic OCR fixture, unrelated to live equipment or its permitted ranges.
    image = np.full((720, 1280, 3), 215, dtype=np.uint8)
    cv2.putText(image, clock, (1040, 40), cv2.FONT_HERSHEY_SIMPLEX, .7, (0,0,0), 2)
    cv2.putText(image, tag, (280+shift, 360), cv2.FONT_HERSHEY_SIMPLEX, .7, (0,0,0), 2)
    cv2.rectangle(image, (365+shift, 343), (465+shift, 365), (85,85,85), -1)
    cv2.putText(image, value, (370+shift, 360), cv2.FONT_HERSHEY_SIMPLEX, .55, (255,255,255), 1)
    cv2.putText(image, "C", (450+shift, 360), cv2.FONT_HERSHEY_SIMPLEX, .55, (255,255,255), 1)
    return cv2.resize(image, (width, int(720*width/1280)))


def test_tag_matching_never_substitutes_letter_o_for_zero():
    data = {"text":["TC-O6","TC-06"],"conf":[99,99],"left":[10,30],"top":[10,30],"width":[20,20],"height":[10,10]}
    assert find_anchors(data,1) == [(30,30,20,10)]


def test_reader_rejects_hidden_region_and_missing_equipment():
    reader = Reader()
    assert reader.read(fixture_frame(), visible=lambda _:False)["status"] == "occluded"
    assert reader.read(fixture_frame(tag="TC-05"))["status"] == "anchor_missing"


def test_reader_tracks_label_after_translation_and_resize():
    for shift, width in [(0,1280),(120,1280),(60,1920)]:
        reader = Reader()
        result = reader.read(fixture_frame(shift=shift,width=width))
        assert result["status"] == "freshness_unverified", result
        assert result["candidate_value_c"] == 123.4, result
        assert result["value_c"] is None


def test_only_progressing_source_clock_can_produce_normal_reading():
    reader = Reader()
    assert reader.read(fixture_frame())["status"] == "freshness_unverified"
    pending = reader.read(fixture_frame(clock="12:34:57"))
    assert pending["status"] == "value_suspect" and pending["value_c"] is None
    good = reader.read(fixture_frame(clock="12:34:58"))
    assert good["status"] == "ok", good
    assert good["value_c"] == 123.4
    reader.clock.changed_at -= 16
    stale = reader.read(fixture_frame(clock="12:34:58"))
    assert stale["status"] == "stale_source", stale
    assert stale["value_c"] is None


def test_duplicate_equipment_labels_are_not_arbitrarily_selected():
    image = fixture_frame()
    cv2.putText(image, "TC-06", (600,500), cv2.FONT_HERSHEY_SIMPLEX, .7, (0,0,0), 2)
    assert Reader().read(image)["status"] == "ambiguous_anchor"


@pytest.mark.parametrize("value", ["38.0", "350.0", "550.0", "900.0", "901.2", "950.0", "980.8", "999.9", "1000.0", "9999.9", "-12.3"])
def test_numeric_regressions_and_high_temperatures(value):
    # Fully synthetic font, not an assertion of field accuracy.
    result = Reader().read(fixture_frame(value=value))
    assert result["status"] == "freshness_unverified", result
    assert result["candidate_value_c"] == float(value), result
    assert result["value_c"] is None


@pytest.mark.parametrize("value", ["900.0", "999.9", "1000.0"])
def test_high_temperature_requires_clock_and_confirmation_before_upload(value):
    reader = Reader()
    assert reader.read(fixture_frame(value=value))["value_c"] is None
    assert reader.read(fixture_frame(value=value, clock="12:34:57"))["value_c"] is None
    result = reader.read(fixture_frame(value=value, clock="12:34:58"))
    assert result["status"] == "ok" and result["value_c"] == float(value), result


def numeric_crop(value):
    return cv2.cvtColor(fixture_frame(value=value)[344:365,366:442], cv2.COLOR_BGR2GRAY)


@pytest.mark.parametrize("texts,confidence,expected", [
    (["350.0", "550.0"], 95, "value_suspect"),
    (["99.9", "99.9"], 95, "value_suspect"),  # Leading digit lost by both OCR modes.
    (["999.9", "999.9"], 40, "low_confidence"),
    (["9999", "9999"], 95, "ocr_failed"),
    (["99.99", "99.99"], 95, "ocr_failed"),
])
def test_disagreement_missing_digits_decimal_and_low_scores_never_pass(monkeypatch, texts, confidence, expected):
    replies = iter(texts)
    monkeypatch.setattr("tc06.ocr.pytesseract.image_to_data", lambda *a, **k: {"text": [next(replies)], "conf": [confidence]})
    value, score, failure = read_number(numeric_crop("999.9"), 60)
    assert value is None and failure == expected


def test_bad_crop_and_decimal_geometry_are_rejected():
    for crop in [np.full((20,60), 85, np.uint8), numeric_crop("999.9")[:,7:]]:
        with pytest.raises(ValueError):
            number_images(crop)
    _, mask = number_images(numeric_crop("999.9"))
    assert matches_layout(mask, "999.9")
    assert not matches_layout(mask, "99.9")
    assert not matches_layout(mask, "9.999")
    # Removing the actual dot must not allow an OCR-invented decimal point.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    for i, part in enumerate(stats[1:], 1):
        if part[3] < 4:
            mask[labels == i] = 0
    assert not matches_layout(mask, "999.9")


def test_failure_and_reconnect_require_new_confirmed_frames():
    reader = Reader()
    for clock in ["12:34:56", "12:34:57", "12:34:58"]:
        result = reader.read(fixture_frame(value="900.0", clock=clock))
    assert result["status"] == "ok"
    assert reader.read(fixture_frame(tag="TC-05"))["status"] == "anchor_missing"
    result = reader.read(fixture_frame(value="900.0", clock="12:34:59"))
    assert result["status"] == "value_suspect" and result["value_c"] is None
    reader.invalidate()
    assert reader.read(fixture_frame(value="900.0", clock="12:35:00"))["status"] == "freshness_unverified"
