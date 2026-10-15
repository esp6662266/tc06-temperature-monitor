from __future__ import annotations

import re
import cv2
import numpy as np
import pytesseract
from pytesseract import Output
from .core import CandidateWatch, ClockWatch, parse_temperature, utc_now
from .runtime import resolve_ocr


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


def number_images(crop):
    """Preserve grayscale edge detail; trim the field and add a light border."""
    if crop.size == 0 or crop.shape[0] < 6 or int(crop.max()) - int(crop.min()) < 40:
        raise ValueError("Numeric pixels are too small or faint")
    _, mask = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    ys, xs = np.where(mask > 0)
    if not len(xs) or xs.min() == 0 or xs.max() == crop.shape[1] - 1 or ys.min() == 0 or ys.max() == crop.shape[0] - 1:
        raise ValueError("Numeric ink touches the crop boundary")
    gray = crop[ys.min():ys.max()+1, xs.min():xs.max()+1]
    gray = 255 - cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    images = [cv2.copyMakeBorder(cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC),
              12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255) for scale in (2, 4)]
    return images, mask


def matches_layout(mask, text):
    """Veto missing digits/decimal points using source pixels, without guessing digits."""
    if not re.fullmatch(r"-?\d{1,4}\.\d", text):
        return False
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    parts = [tuple(map(int, row)) for row in stats[1:] if row[4] >= 2]
    if not parts:
        return False
    height = max(part[3] for part in parts)
    if height < 6:
        return False
    digits = sorted((p for p in parts if p[3] >= height * .6), key=lambda p: p[0])
    if len(digits) != sum(c.isdigit() for c in text):
        return False
    if any(abs(p[1] - digits[0][1]) > height * .3 or abs(p[1]+p[3]-digits[0][1]-digits[0][3]) > height * .3 for p in digits):
        return False
    # Exactly one digit must follow the decimal. A dot can touch that digit in
    # tiny HMI fonts; in that case it is a lower-only left extension of the ink.
    last = digits[-1]
    x, y, w, h, _ = last
    minor = [p for p in parts if p not in digits]
    dots = [p for p in minor if p[0] < x and p[0]+p[2] <= x and p[1] >= y+h*.6 and p[3] <= h*.4 and p[2] <= h*.45]
    left_end = digits[-2][0]+digits[-2][2] if len(digits) > 1 else -1
    dots = [p for p in dots if p[0] >= left_end]
    if not dots:
        ink = mask[y:y+h, x:x+w] > 0
        upper = np.where(ink[:max(1, int(h*.65))].any(axis=0))[0]
        if not len(upper):
            return False
        tail = int(upper.min())
        if not 1 <= tail <= h*.45 or not ink[int(h*.65):, :tail].any():
            return False
    # Any other small mark is unexpected, apart from a single leading minus.
    extras = [p for p in minor if p not in dots]
    if text.startswith("-"):
        signs = [p for p in extras if p[0]+p[2] < digits[0][0] and p[3] <= h*.35 and y+h*.25 <= p[1] <= y+h*.7]
        return len(signs) == 1 and len(extras) == 1
    return not extras and len(dots) <= 1


def read_number(crop, min_confidence):
    images, mask = number_images(crop)
    readings, scores = [], []
    for image, mode in zip(images, (7, 13)):
        words = pytesseract.image_to_data(image, lang="eng", config=f"--psm {mode} -c tessedit_char_whitelist=0123456789.- -c load_system_dawg=0 -c load_freq_dawg=0", output_type=Output.DICT, timeout=5)
        text = "".join(words["text"]).strip()
        if not re.fullmatch(r"-?\d{1,4}\.\d", text):
            return None, 0, "ocr_failed"
        readings.append(text)
        scores.append(min((float(c) for t, c in zip(words["text"], words["conf"]) if t.strip()), default=0))
    confidence = min(scores)
    if readings[0] != readings[1] or not matches_layout(mask, readings[0]):
        return None, confidence, "value_suspect"
    if confidence < min_confidence:
        return None, confidence, "low_confidence"
    return parse_temperature(readings[0]), confidence, None


class Reader:
    def __init__(self, tesseract_path="", min_confidence=60, clock_timeout=15):
        pytesseract.pytesseract.tesseract_cmd = resolve_ocr(tesseract_path)
        self.min_confidence = min_confidence
        self.clock = ClockWatch(clock_timeout)
        self.candidate = CandidateWatch(clock_timeout)

    def invalidate(self):
        self.clock = ClockWatch(self.clock.timeout)
        self.candidate.reset()

    def read(self, frame, visible=None):
        result = self._read(frame, visible)
        if result["status"] != "ok":
            self.candidate.reset()
        elif not self.candidate.update(result["value_c"], result["source_clock"]):
            result.update(status="value_suspect", value_c=None, verification="confirm_next_source_tick")
        return result

    def _read(self, frame, visible=None):
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
        try:
            value, confidence, failure = read_number(crop, self.min_confidence)
        except ValueError:
            return dict(result, status="ocr_failed")
        result["confidence"] = confidence
        if failure:
            return dict(result, status=failure)
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
        result["candidate_value_c"] = value
        return dict(result, status=status, value_c=value if status == "ok" else None)
