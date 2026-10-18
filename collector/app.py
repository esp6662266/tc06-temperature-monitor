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
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from tc06.runtime import resolve_ocr, bundled_ocr
from tc06.recovery import VERSION, STATUS_TEXT, display_reading
from tc06.updates import atomic_json, ControlClient


def runtime_directory():
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "TC06Monitor"


def run_gui(autostart=False, smoke_report=None, update_health=None):
    import tkinter as tk
    from tkinter import ttk, messagebox
    from PIL import Image, ImageTk
    from tc06.capture import windows
    from tc06.worker import Monitor

    runtime = runtime_directory()
    runtime.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(runtime / "monitor.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(levelname)s %(message)s")
    config_path = runtime / "config.json"
    config = json.loads(config_path.read_text("utf-8")) if config_path.exists() else {}
    root = tk.Tk()
    root.title("TC-06 온도 수집기 " + VERSION)
    root.geometry("880x780")
    root.minsize(800, 740)
    pane = ttk.Frame(root, padding=18)
    pane.pack(fill="both", expand=True)
    events, state = queue.Queue(), {"monitor": None, "closing": False, "last_good": None, "reading": None,
        "poller": None, "prepared": None, "ocr_ready": False, "api_ready": False, "health_written": False}
    fields = {}
    labels = [("source", "영상 입력 (window / device)", "window"),
              ("window_title", "HMI 또는 미리보기 창의 정확한 제목", ""),
              ("device_index", "캡처보드 번호 (device 사용 시)", "0"),
              ("device_id", "PC 식별자 (영문·숫자·하이픈)", "hmi-room-01"),
              ("server_url", "온도 사이트 주소 (https://...)", "https://tc06-temperature-monitor.netlify.app"),
              ("tesseract_path", "OCR 엔진 (설치판은 내장 엔진 자동 사용)", resolve_ocr(config.get("tesseract_path", "")))]
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
            if key == "tesseract_path" and bundled_ocr():
                variable.set(resolve_ocr())
                widget.configure(state="readonly")
        widget.grid(row=row, column=1, sticky="ew", pady=5)
    pane.columnconfigure(1, weight=1)
    ttk.Label(pane, text="설정 저장 후에는 프로그램 실행 시 자동으로 수집을 시작합니다.").grid(row=6, column=0, columnspan=2, sticky="w", pady=5)
    value = tk.StringVar(value="— ℃")
    status = tk.StringVar(value="대기 · 첫 정상 판독 즉시 저장, 이후 1분 간격")
    saved = tk.StringVar(value="로컬 저장: 없음")
    uploaded = tk.StringVar(value="서버 저장: 없음")
    detail = tk.StringVar(value="")
    speech_status = tk.StringVar(value="음성: 웹 숫자 TTS 사용 · PC 음성 설치 불필요")
    update_status = tk.StringVar(value="원격 업데이트 연결 전")
    held_status = tk.StringVar(value="")
    reading_panel = ttk.Frame(pane)
    reading_panel.grid(row=7, column=0, columnspan=2, pady=12)
    ttk.Label(reading_panel, textvariable=value, font=("Segoe UI", 36, "bold")).pack()
    ttk.Label(reading_panel, textvariable=held_status, wraplength=760).pack()
    for row, var in enumerate([status, saved, uploaded, detail], 8):
        ttk.Label(pane, textvariable=var, wraplength=700).grid(row=row, column=0, columnspan=2, sticky="w", pady=4)
    preview = ttk.Label(pane, text="판독 영역 미리보기")
    preview.grid(row=12, column=0, columnspan=2, pady=10)
    buttons = ttk.Frame(pane)
    buttons.grid(row=13, column=0, columnspan=2, pady=10)
    ttk.Label(pane, textvariable=speech_status, wraplength=700).grid(row=16, column=0, columnspan=2, sticky="w")
    ttk.Label(pane, textvariable=update_status, wraplength=760).grid(row=17, column=0, columnspan=2, sticky="w", pady=8)

    def start_poller():
        from tc06.updates import UpdatePoller
        if state["poller"]:
            state["poller"].stop()
        if not smoke_report:
            state["poller"] = UpdatePoller(runtime, events.put)
            threading.Thread(target=state["poller"].run, daemon=True).start()

    def pair_updates():
        from tkinter.simpledialog import askstring
        token = askstring("원격 업데이트 연결", "웹 업데이트 관리 화면에서 발급한 이 PC의 연결 코드를 입력하세요.", show="*", parent=root)
        if not token:
            return
        try:
            client = ControlClient(fields["server_url"].get().strip(), fields["device_id"].get().strip(), token.strip())
            # Pairing is explicit and does not start an update.
            client.request("heartbeat", {"version": VERSION, "status": "idle", "command_id": None})
            path = runtime / "update-link.json"
            atomic_json(path, {"base": client.base, "device_id": client.device_id, "token": client.token})
            path.chmod(0o600)
            start_poller()
            update_status.set("원격 업데이트 연결됨 · 적용은 웹의 업데이트 실행 버튼으로 요청")
        except Exception as error:
            messagebox.showerror("업데이트 연결 실패", "서버 주소·PC 식별자·연결 코드를 확인하세요. (" + type(error).__name__ + ")")

    def start():
        if state["monitor"] and state["monitor"].alive():
            messagebox.showinfo("수집기", "이전 작업이 종료 중입니다. 잠시 후 시작하세요")
            return
        try:
            current = {key: var.get().strip() for key, var in fields.items()}
            if not current["device_id"] or not __import__("re").fullmatch(r"[A-Za-z0-9_-]{1,64}", current["device_id"]):
                raise ValueError("PC 식별자는 영문·숫자·하이픈·밑줄 1~64자로 입력하세요")
            current["device_index"] = int(current["device_index"])
            link = runtime / "update-link.json"
            if link.exists():
                paired = json.loads(link.read_text("utf-8"))
                if paired["base"] != current["server_url"].rstrip("/") or paired["device_id"] != current["device_id"]:
                    raise ValueError("업데이트 연결의 서버·PC 식별자와 수집 설정이 다릅니다. 업데이트 연결을 다시 설정하세요.")
            monitor = Monitor(current, runtime, events.put)
            from tc06.core import Outbox
            history = Outbox(runtime / "history.sqlite3")
            try:
                state["last_good"] = history.last_good(current["device_id"])
            finally:
                history.close()
            config_path.write_text(json.dumps(current, ensure_ascii=False, indent=2), "utf-8")
            state["monitor"] = monitor
            state["reading"], state["ocr_ready"], state["api_ready"] = None, False, False
            monitor.start()
            status.set("수집 시작 · 원본 시계 진행 확인 중")
            detail.set("")
        except Exception as error:
            messagebox.showerror("시작 실패", str(error))

    def stop():
        if state["monitor"]:
            state["monitor"].stop()
        value.set("— ℃")
        held_status.set("")
        state["reading"] = None
        status.set("중지 요청 · 진행 중인 판독/전송 종료를 기다리는 중")

    ttk.Button(buttons, text="수집 시작", command=start).pack(side="left", padx=6)
    ttk.Button(buttons, text="중지", command=stop).pack(side="left", padx=6)
    ttk.Button(buttons, text="원격 업데이트 연결", command=pair_updates).pack(side="left", padx=6)
    ttk.Label(pane, text="최소화·가림·시계 미검출 때 정상값을 만들지 않습니다. 영상 표시값의 참고 감시용입니다.", wraplength=700).grid(row=14, column=0, columnspan=2)

    def tick():
        try:
            while True:
                event = events.get_nowait()
                if "reading" in event:
                    reading = event["reading"]
                    state["reading"] = reading
                    if reading["status"] == "ok":
                        state["last_good"] = dict(reading)
                    confirmation = " · 다음 원본 화면에서 숫자 재확인 중" if reading.get("verification") else ""
                    retry = event.get("recovery", {}).get("retry_seconds", 2)
                    status.set(STATUS_TEXT.get(reading["status"], reading["status"]) + confirmation + " / 원본 시계: " + str(reading.get("source_clock") or "미확인") + f" / 다음 판독 {retry}초")
                if event.get("ocr_ready"):
                    state["ocr_ready"] = True
                if "saved_at" in event:
                    saved.set("로컬 저장: " + event["saved_at"])
                if "uploaded_at" in event:
                    state["api_ready"] = True
                    uploaded.set("서버 저장 확인: " + event["uploaded_at"])
                    detail.set("전송 대기: " + str(event.get("pending", 0)))
                for key in ["network_error", "error"]:
                    if key in event:
                        detail.set(event[key])
                if event.get("retention_dropped"):
                    detail.set("30일 보관 기간이 지난 재전송 기록을 정리했습니다.")
                if "update_status" in event:
                    update_status.set(event["update_status"])
                if "update_prepared" in event:
                    if not getattr(sys, "frozen", False):
                        update_status.set("다운로드 완료 · 소스 실행에서는 적용 불가, Windows 설치판을 사용하세요")
                    else:
                        state["prepared"] = event["update_prepared"]
                        if state["monitor"]:
                            state["monitor"].stop()
                        update_status.set("업데이트 적용 중 · 진행 중인 판독·전송 종료 대기")
                if "crop_png" in event:
                    image = Image.open(io.BytesIO(event["crop_png"]))
                    image.thumbnail((600, 80))
                    image = image.resize((max(1, image.width * 3), max(1, image.height * 3)))
                    preview.image = ImageTk.PhotoImage(image)
                    preview.configure(image=preview.image, text="")
        except queue.Empty:
            pass
        if state["reading"] and not state["closing"]:
            import datetime as dt
            reading = state["reading"]
            now = dt.datetime.now(dt.timezone.utc)
            if (now - dt.datetime.fromisoformat(reading["captured_at"])).total_seconds() > 150:
                reading = dict(reading, status="source_error", value_c=None)
            parts = display_reading(reading, state["last_good"], now).split(" · ", 1)
            value.set(parts[0])
            held_status.set(parts[1] if len(parts) > 1 else "")
        if update_health and not state["health_written"] and root.winfo_viewable():
            configured = bool(config.get("server_url") and (config.get("source") == "device" or config.get("window_title")))
            if not configured or (state["ocr_ready"] and state["api_ready"]):
                atomic_json(update_health, {"ok": True, "version": VERSION, "configured": configured,
                    "ocr_ready": state["ocr_ready"], "server_saved": state["api_ready"], "pid": os.getpid()})
                state["health_written"] = True
        if state["prepared"] and not state["closing"] and (not state["monitor"] or not state["monitor"].alive()):
            job = {**state["prepared"], "previous_executable": sys.executable, "parent_pid": os.getpid(), "stopped_at": time.time()}
            job_path = runtime / "updates" / "apply-job.json"
            atomic_json(job_path, job)
            try:
                subprocess.Popen([sys.executable, "--apply-update", str(job_path)], cwd=Path(sys.executable).parent,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
                state["closing"] = True
                if state["poller"]:
                    state["poller"].stop()
            except OSError:
                state["prepared"] = None
                update_status.set("업데이트 도우미 실행 실패 · 기존 수집 다시 시작")
                start()
        if state["closing"] and (not state["monitor"] or not state["monitor"].alive()):
            root.destroy()
            return
        root.after(200, tick)

    def close():
        state["closing"] = True
        if state["poller"]:
            state["poller"].stop()
        stop()

    root.protocol("WM_DELETE_WINDOW", close)
    tick()
    start_poller()
    if smoke_report:
        def finish_smoke():
            root.update_idletasks()
            from PIL import ImageGrab
            path = Path(smoke_report)
            path.parent.mkdir(parents=True, exist_ok=True)
            x, y = root.winfo_rootx(), root.winfo_rooty()
            ImageGrab.grab(bbox=(x, y, x+root.winfo_width(), y+root.winfo_height())).save(path.with_suffix(".png"))
            path.write_text(json.dumps({"ok": True, "title": root.title(), "visible": bool(root.winfo_viewable()),
                            "bundled": bool(getattr(sys, "frozen", False)), "ocr": fields["tesseract_path"].get(),
                            "capture_started": state["monitor"] is not None}, indent=2), encoding="utf-8")
            root.destroy()
        root.after(1000, finish_smoke)
    elif config.get("server_url") and (config.get("source") == "device" or config.get("window_title")):
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
    parser.add_argument("--self-test", metavar="REPORT", help="로컬 합성 OCR 검사 결과를 JSON으로 저장. 캡처·업로드하지 않음")
    parser.add_argument("--smoke-gui", metavar="REPORT", help="설치 검증용 GUI를 열고 닫음. 캡처·업로드하지 않음")
    parser.add_argument("--apply-update", metavar="JOB", help=argparse.SUPPRESS)
    parser.add_argument("--update-health", metavar="REPORT", help=argparse.SUPPRESS)
    parser.add_argument("--direct", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.apply_update:
        from tc06.update_agent import apply_job
        if os.name != "nt" or not getattr(sys, "frozen", False):
            parser.error("업데이트 적용은 Windows 설치판에서만 가능합니다")
        apply_job(args.apply_update, runtime_directory())
        return
    if args.self_test:
        from tc06.selftest import run
        sys.exit(run(args.self_test))
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
    if getattr(sys, "frozen", False) and not args.direct and not args.smoke_gui:
        from tc06.update_agent import active_executable
        try:
            active = active_executable(runtime_directory())
            if active and active.resolve() != Path(sys.executable).resolve():
                subprocess.Popen([str(active), "--direct"], cwd=active.parent)
                return
        except RuntimeError:
            ctypes.windll.user32.MessageBoxW(None, "업데이트 적용 중입니다. 잠시 후 다시 실행하세요.", "TC-06", 0)
            return
        except (OSError, ValueError, KeyError):
            logging.warning("Update pointer unavailable; using installed executable")
    kernel = ctypes.windll.kernel32
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    instance = kernel.CreateMutexW(None, False, "Local\\TC06Monitor_v1")
    if kernel.GetLastError() == 183:
        ctypes.windll.user32.MessageBoxW(None, "TC-06 수집기가 이미 실행 중입니다.", "TC-06", 0)
        return
    try:
        run_gui(args.autostart, args.smoke_gui, args.update_health)
    finally:
        if instance:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(instance)


if __name__ == "__main__":
    main()
