from __future__ import annotations

import argparse
import ctypes
import io
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import queue
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from tc06.core import utc_now


def run_gui(autostart=False):
    import tkinter as tk
    from tkinter import ttk, messagebox
    from PIL import Image, ImageTk
    from tc06.capture import windows
    from tc06.worker import Monitor

    runtime = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "TC06Monitor"
    runtime.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(runtime / "monitor.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(levelname)s %(message)s")
    config_path = runtime / "config.json"
    config = json.loads(config_path.read_text("utf-8")) if config_path.exists() else {}
    root = tk.Tk()
    root.title("TC-06 온도 수집기 0.3.0 · 현장 검증 전")
    root.geometry("760x690")
    root.minsize(650, 630)
    pane = ttk.Frame(root, padding=18)
    pane.pack(fill="both", expand=True)
    events, state = queue.Queue(), {"monitor": None, "closing": False}
    fields = {}
    labels = [("source", "영상 입력 (window / device)", "window"),
              ("window_title", "HMI 또는 미리보기 창의 정확한 제목", ""),
              ("device_index", "캡처보드 번호 (device 사용 시)", "0"),
              ("device_id", "PC 식별자 (영문·숫자·하이픈)", "hmi-room-01"),
              ("server_url", "온도 사이트 주소 (https://...)", "https://tc06-temperature-monitor.netlify.app"),
              ("tesseract_path", "Tesseract 실행파일", r"C:\Program Files\Tesseract-OCR\tesseract.exe")]
    for row, (key, label, default) in enumerate(labels):
        ttk.Label(pane, text=label).grid(row=row, column=0, sticky="w", pady=5)
        variable = tk.StringVar(value=str(config.get(key, default)))
        fields[key] = variable
        if key == "source":
            widget = ttk.Combobox(pane, textvariable=variable, values=["window", "device"], state="readonly")
        elif key == "window_title":
            widget = ttk.Combobox(pane, textvariable=variable, values=[title for _, title in windows()])
        else:
            widget = ttk.Entry(pane, textvariable=variable)
        widget.grid(row=row, column=1, sticky="ew", pady=5)
    pane.columnconfigure(1, weight=1)
    ttk.Label(pane, text="설정 저장 후에는 프로그램 실행 시 자동으로 수집을 시작합니다.").grid(row=6, column=0, columnspan=2, sticky="w", pady=5)
    value = tk.StringVar(value="— ℃")
    status = tk.StringVar(value="대기 · 첫 정상 판독 즉시 저장, 이후 1분 간격")
    saved = tk.StringVar(value="로컬 저장: 없음")
    uploaded = tk.StringVar(value="서버 저장: 없음")
    detail = tk.StringVar(value="")
    speech_status = tk.StringVar(value="음성: 웹 숫자 TTS 사용 · PC 음성 설치 불필요")
    ttk.Label(pane, textvariable=value, font=("Segoe UI", 36, "bold")).grid(row=7, column=0, columnspan=2, pady=12)
    for row, var in enumerate([status, saved, uploaded, detail], 8):
        ttk.Label(pane, textvariable=var, wraplength=700).grid(row=row, column=0, columnspan=2, sticky="w", pady=4)
    preview = ttk.Label(pane, text="판독 영역 미리보기")
    preview.grid(row=12, column=0, columnspan=2, pady=10)
    buttons = ttk.Frame(pane)
    buttons.grid(row=13, column=0, columnspan=2, pady=10)
    ttk.Label(pane, textvariable=speech_status, wraplength=700).grid(row=16, column=0, columnspan=2, sticky="w")

    def start():
        if state["monitor"] and state["monitor"].alive():
            messagebox.showinfo("수집기", "이전 작업이 종료 중입니다. 잠시 후 시작하세요")
            return
        try:
            current = {key: var.get().strip() for key, var in fields.items()}
            if not current["device_id"] or not __import__("re").fullmatch(r"[A-Za-z0-9_-]{1,64}", current["device_id"]):
                raise ValueError("PC 식별자는 영문·숫자·하이픈·밑줄 1~64자로 입력하세요")
            current["device_index"] = int(current["device_index"])
            monitor = Monitor(current, runtime, events.put)
            config_path.write_text(json.dumps(current, ensure_ascii=False, indent=2), "utf-8")
            state["monitor"] = monitor
            monitor.start()
            status.set("수집 시작 · 원본 시계 진행 확인 중")
            detail.set("")
        except Exception as error:
            messagebox.showerror("시작 실패", str(error))

    def stop():
        if state["monitor"]:
            state["monitor"].stop()
        value.set("— ℃")
        status.set("중지 요청 · 진행 중인 판독/전송 종료를 기다리는 중")

    ttk.Button(buttons, text="수집 시작", command=start).pack(side="left", padx=6)
    ttk.Button(buttons, text="중지", command=stop).pack(side="left", padx=6)
    ttk.Label(pane, text="최소화·가림·시계 미검출 때 정상값을 만들지 않습니다. 영상 표시값의 참고 감시용입니다.", wraplength=700).grid(row=14, column=0, columnspan=2)

    def tick():
        try:
            while True:
                event = events.get_nowait()
                if "reading" in event:
                    reading = event["reading"]
                    value.set(f"{reading['value_c']:.1f} ℃" if reading["status"] == "ok" else "— ℃")
                    status.set("판독 상태: " + reading["status"] + " / 원본 시계: " + str(reading.get("source_clock") or "미확인"))
                if "saved_at" in event:
                    saved.set("로컬 저장: " + event["saved_at"])
                if "uploaded_at" in event:
                    uploaded.set("서버 저장 확인: " + event["uploaded_at"])
                    detail.set("전송 대기: " + str(event.get("pending", 0)))
                for key in ["network_error", "error"]:
                    if key in event:
                        detail.set(event[key])
                if event.get("retention_dropped"):
                    detail.set("30일 보관 기간이 지난 재전송 기록을 정리했습니다.")
                if "crop_png" in event:
                    image = Image.open(io.BytesIO(event["crop_png"]))
                    image.thumbnail((600, 80))
                    image = image.resize((max(1, image.width * 3), max(1, image.height * 3)))
                    preview.image = ImageTk.PhotoImage(image)
                    preview.configure(image=preview.image, text="")
        except queue.Empty:
            pass
        if state["closing"] and (not state["monitor"] or not state["monitor"].alive()):
            root.destroy()
            return
        root.after(200, tick)

    def close():
        state["closing"] = True
        stop()

    root.protocol("WM_DELETE_WINDOW", close)
    tick()
    if config.get("server_url") and (config.get("source") == "device" or config.get("window_title")):
        root.after(1000, start)
    root.mainloop()


def main():
    if os.name == "nt":
        try:
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="TC-06 영상 OCR 수집기")
    parser.add_argument("--image", help="정지 이미지 로컬 판독 확인; 서버에 전송하지 않음")
    parser.add_argument("--list-windows", action="store_true")
    parser.add_argument("--autostart", action="store_true", help="호환용 옵션: 저장된 설정이 있으면 기본적으로 자동 시작")
    args = parser.parse_args()
    if args.image:
        import cv2
        from tc06.ocr import Reader
        frame = cv2.imread(args.image)
        if frame is None:
            parser.error("이미지를 읽을 수 없습니다")
        result = Reader().read(frame)
        result.update(live=False, sample_only=True)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    if args.list_windows:
        from tc06.capture import windows
        for _, title in windows():
            print(title)
        return
    if os.name != "nt":
        parser.error("실시간 GUI는 Windows 전용입니다. --image로 로컬 OCR 검증 가능")
    kernel = ctypes.windll.kernel32
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    instance = kernel.CreateMutexW(None, False, "Local\\TC06Monitor_v1")
    if kernel.GetLastError() == 183:
        ctypes.windll.user32.MessageBoxW(None, "TC-06 수집기가 이미 실행 중입니다.", "TC-06", 0)
        return
    try:
        run_gui(args.autostart)
    finally:
        if instance:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(instance)


if __name__ == "__main__":
    main()
