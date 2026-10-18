"""Authenticated control client and signed, official-repository-only staging."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import threading
import time
import urllib.request
from urllib.parse import urlparse
import uuid
import zipfile
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .recovery import VERSION
from .trust import PUBLIC_KEY

REPO = "https://github.com/esp6662266/tc06-temperature-monitor"
API = "https://api.github.com/repos/esp6662266/tc06-temperature-monitor/releases/latest"
MAX_ZIP = 300_000_000
MAX_UNPACKED = 900_000_000


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{1,4}\.\d{1,4}\.\d{1,4}", value):
        raise ValueError("Invalid release version")
    return tuple(map(int, value.split(".")))


def verify_manifest(envelope, current=VERSION, public_key=PUBLIC_KEY):
    raw = base64.b64decode(envelope["payload"], validate=True)
    if len(raw) > 4096:
        raise ValueError("Manifest too large")
    Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key, validate=True)).verify(
        base64.b64decode(envelope["signature"], validate=True), raw)
    data = json.loads(raw)
    version = data["version"]
    if version_tuple(version) <= version_tuple(current):
        raise ValueError("Same version or downgrade refused")
    expected = f"{REPO}/releases/download/v{version}/TC06Monitor-Portable-{version}-x64.zip"
    if data.get("url") != expected or not re.fullmatch(r"[0-9a-f]{64}", data.get("sha256", "")):
        raise ValueError("Unapproved release origin or checksum")
    for name, limit in (("size", MAX_ZIP), ("unpacked_size", MAX_UNPACKED)):
        if type(data.get(name)) is not int or not 0 < data[name] <= limit:
            raise ValueError("Invalid release size")
    return data


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}:
            raise ValueError("Release redirect refused")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def release_open(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"github.com", "api.github.com"}:
        raise ValueError("Unapproved release host")
    return urllib.request.build_opener(ReleaseRedirect()).open(
        urllib.request.Request(url, headers={"User-Agent": "TC06Monitor/" + VERSION}), timeout=30)


def latest_manifest():
    with release_open(API) as response:
        release = json.loads(response.read(500_000))
    asset = next((a for a in release.get("assets", []) if a["name"] == "update-manifest.json"), None)
    if not asset:
        return None
    version = release["tag_name"].removeprefix("v")
    if asset["browser_download_url"] != f"{REPO}/releases/download/v{version}/update-manifest.json":
        raise ValueError("Invalid manifest origin")
    with release_open(asset["browser_download_url"]) as response:
        envelope = json.loads(response.read(16_384))
    # Zero baseline validates a release even when the agent already has it.
    data = verify_manifest(envelope, "0.0.0")
    return {"envelope": envelope, "version": data["version"]}


def stage_release(envelope, runtime, current=VERSION, opener=release_open, cancel=None):
    data = verify_manifest(envelope, current)
    runtime = Path(runtime)
    updates = runtime / "updates"
    updates.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(updates).free < data["size"] + data["unpacked_size"] + 100_000_000:
        raise OSError("Insufficient update disk space")
    part = updates / (uuid.uuid4().hex + ".part")
    unpack = updates / (uuid.uuid4().hex + ".staging")
    target = updates / "versions" / data["version"]
    try:
        digest, size, started = hashlib.sha256(), 0, time.monotonic()
        with opener(data["url"]) as response, part.open("wb") as stream:
            while True:
                if cancel and cancel.is_set():
                    raise InterruptedError("Update cancelled")
                block = response.read(256_000)
                if not block:
                    break
                size += len(block)
                if size > data["size"]:
                    raise ValueError("Download exceeds signed size")
                stream.write(block)
                digest.update(block)
                # Bound background bandwidth to about 4 MB/s.
                wait = size / 4_000_000 - (time.monotonic() - started)
                if wait > 0:
                    if cancel:
                        if cancel.wait(wait):
                            raise InterruptedError("Update cancelled")
                    else:
                        time.sleep(wait)
        if size != data["size"] or digest.hexdigest() != data["sha256"]:
            raise ValueError("Release checksum or size mismatch")
        with zipfile.ZipFile(part) as archive:
            infos = archive.infolist()
            if len(infos) > 10_000 or sum(info.file_size for info in infos) != data["unpacked_size"]:
                raise ValueError("Archive unpacked size mismatch")
            seen = set()
            for info in infos:
                name = info.filename
                path = PurePosixPath(name)
                if (not name or not path.parts or "\\" in name or ":" in name or path.is_absolute() or
                        any(piece in {"..", "."} or piece.endswith((".", " ")) for piece in path.parts) or
                        stat.S_ISLNK(info.external_attr >> 16) or name.casefold() in seen):
                    raise ValueError("Unsafe archive entry")
                if any(piece.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1,10)], *[f"LPT{i}" for i in range(1,10)]} for piece in path.parts):
                    raise ValueError("Reserved Windows archive path")
                seen.add(name.casefold())
            archive.extractall(unpack)
        for file in ("TC06Monitor.exe", "ocr/tesseract.exe", "ocr/tessdata/eng.traineddata"):
            if not (unpack / file).is_file():
                raise ValueError("Incomplete portable release")
        atomic_json(unpack / "verified-release.json", envelope)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            # A cancelled apply may have left an already verified release. Reuse
            # only if every file still matches the freshly verified archive.
            for expected in unpack.rglob("*"):
                if expected.is_file():
                    existing = target / expected.relative_to(unpack)
                    if existing.is_symlink() or not existing.is_file() or hashlib.sha256(existing.read_bytes()).digest() != hashlib.sha256(expected.read_bytes()).digest():
                        raise ValueError("Existing version differs from verified release")
            return target / "TC06Monitor.exe"
        os.replace(unpack, target)
        return target / "TC06Monitor.exe"
    finally:
        part.unlink(missing_ok=True)
        shutil.rmtree(unpack, ignore_errors=True)


class ControlClient:
    def __init__(self, base, device_id, token):
        from .worker import validate_endpoint
        self.base = validate_endpoint(base)
        self.device_id, self.token = device_id, token
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", device_id) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
            raise ValueError("Invalid update pairing")

    def request(self, action, data=None):
        # Refuse redirects so a device credential never leaves the paired origin.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                raise ValueError("Control redirect refused")
        request = urllib.request.Request(self.base + "/api/updates/device/" + self.device_id + "/" + action,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            return json.loads(response.read(32_768))


class UpdatePoller:
    def __init__(self, runtime, notify, version=VERSION):
        self.runtime, self.notify, self.version = Path(runtime), notify, version
        self.stop_event = threading.Event()
        self.status = "idle"
        self.command_id = None
        self.seen = set()
        self.client = None
        self.latest = None
        self.result = None

    def stop(self):
        self.stop_event.set()

    def run(self):
        try:
            config = json.loads((self.runtime / "update-link.json").read_text("utf-8"))
            self.client = ControlClient(**config)
            prior = self.runtime / "updates" / "result.json"
            interrupted = self.runtime / "updates" / "last-command.json"
            if interrupted.exists():
                self.command_id = json.loads(interrupted.read_text("utf-8"))["command_id"]
                self.status = "failed"
                self.seen.add(self.command_id)
            if prior.exists():
                result = json.loads(prior.read_text("utf-8"))
                if self.command_id is None or self.command_id == result["command_id"]:
                    self.command_id, self.status = result["command_id"], result["status"]
                    self.seen.add(self.command_id)
                    self.result = result
            journal = self.runtime / "updates" / "transaction.json"
            if journal.exists():
                transaction = json.loads(journal.read_text("utf-8"))
                if transaction.get("command_id") == self.command_id and transaction.get("status") == "switching":
                    self.status = "switching"
        except (OSError, ValueError, TypeError, KeyError):
            self.notify({"update_status": "원격 업데이트 연결 전"})
            return
        checked_at = float("-inf")
        while not self.stop_event.is_set():
            try:
                prior = self.runtime / "updates" / "result.json"
                if self.command_id and prior.exists():
                    result = json.loads(prior.read_text("utf-8"))
                    if result.get("command_id") == self.command_id:
                        self.status, self.result = result["status"], result
                if time.monotonic() - checked_at >= 1800:
                    checked_at = time.monotonic()
                    try:
                        self.latest = latest_manifest()
                    except Exception:
                        self.latest = None
                response = self.client.request("heartbeat", {"version": self.version, "status": self.status,
                    "command_id": self.command_id, "available": self.latest, "result": self.result})
                command = response.get("command")
                if command and command["id"] not in self.seen:
                    self.seen.add(command["id"])
                    # The server atomically consumes this unique, unexpired command.
                    self.client.request("claim", {"command_id": command["id"]})
                    self.command_id, self.status = command["id"], "downloading"
                    atomic_json(self.runtime / "updates" / "last-command.json", {"command_id": self.command_id})
                    self.notify({"update_status": "업데이트 다운로드·서명 확인 중 · 온도 수집 계속"})
                    self.client.request("heartbeat", {"version": self.version, "status": self.status, "command_id": self.command_id})
                    try:
                        executable = stage_release(command["manifest"], self.runtime, self.version, cancel=self.stop_event)
                        if self.stop_event.is_set():
                            return
                        self.client.request("ready", {"command_id": self.command_id})
                        self.status = "ready"
                        self.notify({"update_prepared": {"command_id": self.command_id, "executable": str(executable),
                            "version": verify_manifest(command["manifest"], self.version)["version"], "expires_at": command["expires_at"]},
                            "update_status": "다운로드 확인 완료 · 수집기 교체 준비"})
                        return
                    except Exception as error:
                        self.status = "failed"
                        self.notify({"update_status": "업데이트 준비 실패 · 기존 수집 계속 (" + type(error).__name__ + ")"})
                elif self.status == "idle":
                    label = "업데이트 연결됨 · 새 버전 없음"
                    if self.latest and version_tuple(self.latest["version"]) > version_tuple(self.version):
                        label = "새 버전 " + self.latest["version"] + " · 웹에서 업데이트 실행 가능"
                    self.notify({"update_status": label})
                else:
                    labels = {"completed": "업데이트 완료 · 현재 버전 " + self.version,
                        "rolled_back": "업데이트 실패 후 이전 버전으로 복구됨 · " + self.version,
                        "failed": "업데이트 실패 · 기존 수집 계속", "switching": "새 버전 시작 확인 중"}
                    self.notify({"update_status": labels.get(self.status, "업데이트 상태: " + self.status)})
            except Exception:
                self.notify({"update_status": "업데이트 서버 연결 확인 필요 · 온도 수집 계속"})
            self.stop_event.wait(15)
