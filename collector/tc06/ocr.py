from __future__ import annotations

import re
import cv2
import numpy as np
import pytesseract
from pytesseract import Output
from .core import ClockWatch, parse_temperature, utc_now


def clean_tag(text):
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def find_anchors(data, scale):
    found = []
    for i, text in enumerate(data["text"]):
        # Never silently replace O with 0 in an equipment identifier.
        if clean_tag(text) != "TC06" or float(data["conf"][i]) < 20:
            continue
        found.append(tuple(int(data[k][i] / scale) for k in ("left", "top", "width", "height")))
    return found


def value_box(anchor, gray):
    x, y, w, h = anchor
    # Follow the flat gray fill instead of connected dark pixels: adjacent
    # fields can share borders and process lines can touch their outlines.
    cy = min(gray.shape[0] - 1, y + h // 2)
    left = x + w + 1
    for cx in range(left, min(gray.shape[1], left + max(16, h * 2))):
        color = int(gray[cy, cx])
        if not 40 <= color <= 170:
            continue
        close = lambda yy, xx: abs(int(gray[yy, xx]) - color) <= 12
        top, bottom = cy, cy + 1
        while top > max(0, y - h * 2) and close(top - 1, cx):
            top -= 1
        while bottom < min(gray.shape[0], y + h * 4) and close(bottom, cx):
            bottom += 1
        rh = bottom - top
        if not .9 * h <= rh <= 3 * h:
            continue
        x1, x2 = cx, cx + 1
        while x1 > left and close(top, x1 - 1):
            x1 -= 1
        while x2 < min(gray.shape[1], left + h * 20) and close(top, x2):
            x2 += 1
        if not 5 * h <= x2 - x1 <= 19 * h:
            continue
        # Unit column is one field-height wide; never OCR the degree symbol.
        return x1 + 1, top + 1, x2 - (rh + 1), bottom - 1
    return None


class Reader:
    def __init__(self, tesseract_path="", min_confidence=60, clock_timeout=15):
        if tesseract_path:
            pytesseract.pytesseract.tesseract_cmd = tesseract_path
        self.min_confidence = min_confidence
        self.clock = ClockWatch(clock_timeout)

    def read(self, frame, visible=None):
        started = utc_now()
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        scale = min(4.0, max(1.0, 3840 / frame.shape[1]))
        enlarged = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        data = pytesseract.image_to_data(enlarged, config="--psm 11", lang="eng", output_type=Output.DICT, timeout=12)
        anchors = find_anchors(data, scale)
        result = {"captured_at": started, "value_c": None, "confidence": 0, "source_clock": None}
        if len(anchors) != 1:
            return dict(result, status="anchor_missing" if not anchors else "ambiguous_anchor")
        anchor = anchors[0]
        box = value_box(anchor, gray)
        if box is None:
            return dict(result, status="ocr_failed")
        x1, y1, x2, y2 = box
        # Reject occlusion of the entire label + value rectangle.
        region = (anchor[0], min(anchor[1], y1), x2, y2)
        if visible and not visible(region):
            return dict(result, status="occluded")
        result["roi"] = [x1, y1, x2, y2]
        crop = gray[y1:y2, x1:x2]
        if crop.size == 0 or crop.shape[0] < 6:
            return dict(result, status="ocr_failed")
        enlarged_crop = 255 - cv2.resize(crop, None, fx=6, fy=6, interpolation=cv2.INTER_CUBIC)
        predictions, scores = [], []
        for image in (enlarged_crop, cv2.threshold(enlarged_crop, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]):
            words = pytesseract.image_to_data(image, lang="eng", config="--psm 7 -c tessedit_char_whitelist=0123456789.-C", output_type=Output.DICT, timeout=5)
            text = "".join(words["text"])
            try:
                predictions.append(parse_temperature(text))
            except ValueError:
                return dict(result, status="ocr_failed")
            valid_scores = [float(c) for t, c in zip(words["text"], words["conf"]) if t.strip()]
            scores.append(min(valid_scores, default=0))
        if predictions[0] != predictions[1]:
            return dict(result, status="value_suspect")
        result["confidence"] = min(scores)
        if min(scores) < self.min_confidence:
            return dict(result, status="low_confidence")
        # Clock can be anywhere in the top 12% of the selected video/window.
        clocks = []
        for text, top, left, width, height in zip(data["text"], data["top"], data["left"], data["width"], data["height"]):
            match = re.search(r"(?<!\d)(\d{1,2}:\d{2}:\d{2})(?!\d)", text)
            if match and top / scale < frame.shape[0] * .12:
                box = tuple(int(v / scale) for v in (left, top, width, height))
                if not visible or visible((box[0], box[1], box[0] + box[2], box[1] + box[3])):
                    clocks.append(match.group(1))
        if len(clocks) == 1:
            result["source_clock"] = clocks[0]
        status = self.clock.update(result["source_clock"])
        result["candidate_value_c"] = predictions[0]
        return dict(result, status=status, value_c=predictions[0] if status == "ok" else None)
