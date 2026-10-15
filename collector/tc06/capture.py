from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import threading
import time
import cv2
import numpy as np


def windows():
    if os.name != "nt":
        raise RuntimeError("Window capture requires Windows")
    user = ctypes.windll.user32
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    entries = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        if user.IsWindowVisible(hwnd) and user.GetWindowTextLengthW(hwnd):
            title = ctypes.create_unicode_buffer(user.GetWindowTextLengthW(hwnd) + 1)
            user.GetWindowTextW(hwnd, title, len(title))
            entries.append((int(hwnd), title.value))
        return True
    user.EnumWindows(callback_type(callback), 0)
    return entries


class WindowSource:
    """Visible-screen capture; follows client bounds and rejects covered regions."""
    def __init__(self, title):
        import mss
        self.title = title
        self.user = ctypes.windll.user32
        # 64-bit HWND return values must not be truncated.
        self.user.WindowFromPoint.argtypes = [wintypes.POINT]
        self.user.WindowFromPoint.restype = wintypes.HWND
        self.user.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        self.user.GetAncestor.restype = wintypes.HWND
        self.user.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.user.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
        self.user.IsIconic.argtypes = [wintypes.HWND]
        self.sct = mss.mss()
        self.origin = (0, 0)
        self.hwnd = None

    def read(self):
        matches = [(h, t) for h, t in windows() if t == self.title]
        if len(matches) != 1:
            raise RuntimeError("window_missing: 정확한 제목과 일치하는 창이 하나여야 합니다")
        hwnd = matches[0][0]
        if self.user.IsIconic(hwnd):
            raise RuntimeError("window_missing: 선택한 창이 최소화되었습니다")
        rect, point = wintypes.RECT(), wintypes.POINT(0, 0)
        if not self.user.GetClientRect(hwnd, ctypes.byref(rect)) or not self.user.ClientToScreen(hwnd, ctypes.byref(point)):
            raise RuntimeError("window_missing")
        if rect.right < 200 or rect.bottom < 150:
            raise RuntimeError("source_error: 창 크기가 너무 작습니다")
        self.hwnd, self.origin = hwnd, (point.x, point.y)
        frame = self.sct.grab({"left": point.x, "top": point.y, "width": rect.right, "height": rect.bottom})
        return np.asarray(frame)[:, :, :3].copy()

    def visible(self, box):
        # Sample every 4 px to reject other application windows across the ROI.
        x1, y1, x2, y2 = box
        for y in range(y1, y2 + 1, 4):
            for x in range(x1, x2 + 1, 4):
                point = wintypes.POINT(self.origin[0] + x, self.origin[1] + y)
                top = self.user.WindowFromPoint(point)
                root = self.user.GetAncestor(top, 2)
                if root != self.hwnd:
                    return False
        return True

    def close(self):
        self.sct.close()


class DeviceSource:
    """Continuously drains capture card frames so OCR never reads a queued old frame."""
    def __init__(self, index):
        self.cap = cv2.VideoCapture(int(index), cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY)
        if not self.cap.isOpened():
            raise RuntimeError("캡처 장치를 열 수 없습니다. 다른 앱의 장치 독점을 확인하세요")
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.ready = threading.Event()
        self.frame, self.at = None, 0
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        try:
            while not self.stopped.is_set():
                ok, frame = self.cap.read()
                if ok:
                    with self.lock:
                        self.frame, self.at = frame, time.monotonic()
                    self.ready.set()
                else:
                    self.stopped.wait(.1)
        finally:
            self.cap.release()

    def read(self):
        self.ready.wait(timeout=5)
        with self.lock:
            if self.frame is None or time.monotonic() - self.at > 3:
                raise RuntimeError("source_error: 최근 캡처 프레임 없음")
            return self.frame.copy()

    def close(self):
        self.stopped.set()
        self.thread.join(timeout=3)
