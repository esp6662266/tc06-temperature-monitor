"""Synthetic quality variations: rejected inputs are allowed; wrong accepted values are not.

This is a small regression corpus, not a field accuracy benchmark or a guarantee.
"""
import cv2
import pytest
from test_ocr import numeric_crop
from tc06.ocr import read_number


@pytest.mark.parametrize("value", ["38.0", "350.0", "550.0", "900.0", "909.9", "950.0", "999.9", "1000.0", "1234.5"])
@pytest.mark.parametrize("quality", ["original", "small", "blur", "jpeg"])
def test_quality_variations_either_read_correctly_or_reject(value, quality):
    crop = numeric_crop(value)
    if quality == "small":
        crop = cv2.resize(crop, None, fx=.75, fy=.75, interpolation=cv2.INTER_AREA)
    elif quality == "blur":
        crop = cv2.GaussianBlur(crop, (3,3), .6)
    elif quality == "jpeg":
        encoded = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 50])[1]
        crop = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
    try:
        actual, confidence, failure = read_number(crop, 60)
    except ValueError:
        actual, failure = None, "bad_crop"
    if failure is None:
        assert actual == float(value), (value, quality, actual, confidence)
    else:
        assert actual is None
    if quality == "original" and value != "1234.5":
        assert failure is None, (value, failure)


def test_nine_hundreds_corpus_never_silently_accepts_wrong_value():
    accepted = rejected = 0
    for integer in range(900, 1000):
        value = f"{integer}.{integer % 10}"
        actual, confidence, failure = read_number(numeric_crop(value), 60)
        if failure is None:
            assert actual == float(value), (value, actual, confidence)
            accepted += 1
        else:
            assert actual is None
            rejected += 1
    print(f"900–999 synthetic corpus: {accepted} correct / {rejected} rejected / 0 wrong accepted")
