import cv2
import numpy as np
from tc06.ocr import Reader, find_anchors


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
    good = reader.read(fixture_frame(clock="12:34:57"))
    assert good["status"] == "ok", good
    assert good["value_c"] == 123.4
    reader.clock.changed_at -= 16
    stale = reader.read(fixture_frame(clock="12:34:57"))
    assert stale["status"] == "stale_source", stale
    assert stale["value_c"] is None


def test_duplicate_equipment_labels_are_not_arbitrarily_selected():
    image = fixture_frame()
    cv2.putText(image, "TC-06", (600,500), cv2.FONT_HERSHEY_SIMPLEX, .7, (0,0,0), 2)
    assert Reader().read(image)["status"] == "ambiguous_anchor"
