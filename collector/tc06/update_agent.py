"""Collector-only process handoff. No installer, OS reboot or HMI operations."""
from __future__ import annotations
import ctypes
import json
import os
from pathlib import Path
import subprocess
import time
from .updates import atomic_json, version_tuple


def active_executable(runtime):
    root = Path(runtime) / "updates"
    journal = root / "transaction.json"
    pointer = root / "active.json"
    if journal.exists():
        transaction = json.loads(journal.read_text("utf-8"))
        if transaction["status"] == "switching":
            try:
                with UpdateLock(root / "agent.lock"):
                    transaction = json.loads(journal.read_text("utf-8"))
                    if transaction["status"] != "switching":
                        return active_executable(runtime)
                    # Power loss or agent crash: restore last known working pointer.
                    atomic_json(pointer, transaction["previous_pointer"])
                    transaction["status"] = "rolled_back"
                    atomic_json(journal, transaction)
                    atomic_json(root / "result.json", {"status": "rolled_back", "command_id": transaction["command_id"],
                        "reason": "interrupted_switch", "finished_at": time.time()})
            except OSError as error:
                raise RuntimeError("Update agent still running") from error
    if not pointer.exists():
        return None
    data = json.loads(pointer.read_text("utf-8"))
    if not data.get("executable"):
        return None
    version_tuple(data["version"])
    exe = Path(data["executable"]).resolve()
    expected = (root / "versions" / data["version"] / "TC06Monitor.exe").resolve()
    if exe != expected or not exe.is_file():
        raise ValueError("Invalid active release pointer")
    return exe


def wait_parent(pid, timeout=45):
    if os.name != "nt":
        raise RuntimeError("Windows update agent only")
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE, never terminate permission.
    if not handle and kernel.GetLastError() != 87:
        raise OSError("Cannot verify previous collector exit")
    if handle:
        try:
            kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            if kernel.WaitForSingleObject(handle, timeout * 1000) != 0:
                raise TimeoutError("Previous collector did not stop")
        finally:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(handle)


class UpdateLock:
    def __init__(self, path):
        self.path, self.stream = Path(path), None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        try:
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                if self.path.stat().st_size == 0:
                    self.stream.write(b"0")
                    self.stream.flush()
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            self.stream.close()
            raise
        return self

    def __exit__(self, *args):
        self.stream.close()  # OS releases locks on crash as well.


def apply_transaction(runtime, job, start, check, stop_new, wait_old=wait_parent):
    """Injected process adapters allow interrupted/failed launches to be tested safely."""
    root = Path(runtime) / "updates"
    with UpdateLock(root / "agent.lock"):
        result_path = root / "result.json"
        if result_path.exists() and json.loads(result_path.read_text("utf-8")).get("command_id") == job["command_id"]:
            raise ValueError("Already applied command")
        pointer = root / "active.json"
        previous = json.loads(pointer.read_text("utf-8")) if pointer.exists() else {}
        transaction = {**job, "previous_pointer": previous, "status": "preflight"}
        atomic_json(root / "transaction.json", transaction)
        process = None
        switched = False
        try:
            if job.get("expires_at", float("inf")) <= time.time() * 1000:
                raise TimeoutError("Update authorization expired")
            check(Path(job["executable"]), preflight=True)
            wait_old(job["parent_pid"])
            if job.get("expires_at", float("inf")) <= time.time() * 1000:
                raise TimeoutError("Update authorization expired")
            transaction["status"] = "switching"
            atomic_json(root / "transaction.json", transaction)
            atomic_json(pointer, {"executable": job["executable"], "version": job["version"]})
            switched = True
            process = start(Path(job["executable"]), health=True)
            check(process, preflight=False)
            transaction["status"] = "completed"
            atomic_json(root / "transaction.json", transaction)
            outcome = {"command_id": job["command_id"], "status": "completed", "version": job["version"],
                       "finished_at": time.time(), "gap_seconds": round(time.time() - job["stopped_at"], 1)}
            atomic_json(result_path, outcome)
            return outcome
        except Exception as error:
            if process is not None:
                stop_new(process)
            if switched:
                atomic_json(pointer, previous)
            transaction["status"] = "rolled_back"
            atomic_json(root / "transaction.json", transaction)
            outcome = {"command_id": job["command_id"], "status": "rolled_back", "reason": type(error).__name__,
                       "finished_at": time.time(), "gap_seconds": round(time.time() - job["stopped_at"], 1)}
            atomic_json(result_path, outcome)
            # Only after the old process has actually exited; never duplicate it.
            wait_old(job["parent_pid"])
            start(Path(job["previous_executable"]), health=False)
            return outcome


def apply_job(path, runtime):
    job = json.loads(Path(path).read_text("utf-8"))
    root = Path(runtime) / "updates"
    expected = (root / "versions" / job["version"] / "TC06Monitor.exe").resolve()
    if Path(job["executable"]).resolve() != expected:
        raise ValueError("Update job is outside staged releases")
    report = root / (job["command_id"] + "-health.json")
    report.unlink(missing_ok=True)
    def launch(exe, health):
        args = [str(exe), "--direct"]
        if health:
            args += ["--update-health", str(report)]
        return subprocess.Popen(args, cwd=exe.parent, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)

    def check(target, preflight):
        if preflight:
            self_report = root / (job["command_id"] + "-selftest.json")
            self_report.unlink(missing_ok=True)
            subprocess.run([str(target), "--self-test", str(self_report)], cwd=target.parent, timeout=90, check=True)
            result = json.loads(self_report.read_text("utf-8"))
            if result.get("ok") is not True or result.get("bundled") is not True:
                raise RuntimeError("New bundled OCR preflight failed")
        else:
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if target.poll() is not None:
                    raise RuntimeError("New collector exited")
                if report.exists():
                    ready = json.loads(report.read_text("utf-8"))
                    if ready.get("ok") and ready.get("version") == job["version"]:
                        return
                time.sleep(.5)
            raise TimeoutError("New collector readiness timed out")

    def stop_new(process):
        if process.poll() is None:
            process.terminate()  # Only this helper's own newly spawned collector.
            process.wait(timeout=15)

    return apply_transaction(runtime, job, launch, check, stop_new)
