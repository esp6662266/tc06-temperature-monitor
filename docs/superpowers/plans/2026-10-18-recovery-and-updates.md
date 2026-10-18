# OCR Recovery and Remote Updates Implementation Plan

> **Execution:** Follow the project instructions and existing user authorization. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Recover quickly from OCR failures and deliver explicitly requested, verified Windows updates with rollback.

**Architecture:** Preserve continuous strict OCR, one-minute persistence, source-clock checks and the public temperature API. Add bounded local diagnostics and an independent authenticated update channel; stage signed portable releases while collecting, then stop only the collector, switch a version pointer and verify startup or restore the previous executable.

**Tech Stack:** Python/Tk/OpenCV/SQLite, Ed25519 signatures, Node/Netlify Blobs, plain HTML/JS, GitHub Actions Windows 2022.

**Spec:** `docs/REMOTE_UPDATE_DESIGN.md` and the user's eight accepted proposals in this chat.

## Global Constraints

- No HMI/PLC/Windows restart or control; no changes to temperature API authentication.
- Failure records remain null; capture time remains original; forecasts remain display-only.
- Every retry captures a new frame; keep strict two-mode OCR and next source-tick confirmation.
- Only an authenticated, expiring, unique administrator command may apply an update.
- Update payloads must match a pinned Ed25519 key, official repository URL, size and SHA-256.
- Keep config/history/outbox outside executable directories; never commit operational images or secrets.
- Tests/builds do not establish real HMI/TV or field installation success.

## Review Focus

- Long failure then recovery must store the recovered real reading immediately, without manufacturing missed minutes.
- Slow OCR/capture, minimized windows and frozen source clock must remain distinguishable failures.
- Concurrent update clicks, replay and stale agent heartbeats must not cause repeated or wrong-device execution.
- Interrupted downloads, unsafe archive paths and invalid signatures must leave the collector running.
- Failed startup or power loss during switching must leave the previous version recoverable and preserve SQLite/config.

---

### Task 1: OCR recovery and bounded diagnostics

**Files:** `collector/tc06/recovery.py`, `worker.py`, `ocr.py`, `collector/app.py`, `tests/test_recovery.py`.

**Interfaces:** `Recovery.observe(reading, now)` returns retry interval and immediate-recovery-save flag. `Diagnostics.record(reading, frame, now)` stores only bounded ROI evidence locally.

- [x] Test fast/slow retry, recovery persistence, no invented minutes, stopped clock, capture-vs-OCR errors, bounded images/logs.
- [x] Implement 2s healthy / 3s initial failure / 10s after 30s failure, with 60s null records and immediate confirmed recovery.
- [x] Show last normal value with original age and categorized failure status in the collector GUI.
- [x] Run Python tests.

### Task 2: Update delivery and recovery engine

**Files:** `collector/tc06/updates.py`, `update_agent.py`, `trust.py`, `collector/app.py`, `scripts/sign-update.py`, `scripts/Build-Windows.ps1`, workflow, update tests.

**Interfaces:** signed envelope `{payload: base64(JSON bytes), signature: base64(Ed25519)}`; payload includes version, official portable URL, size, sha256, unpacked_size. Pointer contains absolute executable, previous executable and command id.

- [x] Test tampering, wrong origin/version, truncated download, traversal/symlinks/zip bombs, replay, lock exclusion, recovery and preserved data.
- [x] Implement verified staging, independent agent, atomic pointer and health/rollback transaction; retain previous version.
- [x] Add explicit pairing/settings, update state and process handoff to GUI. Base installed executable launches the active version on subsequent starts.
- [x] Sign only after Windows build/install/self-tests succeed; make signed manifests downloadable release assets.

### Task 3: Authenticated remote control and administration

**Files:** `server/updates.mjs`, `netlify/functions/updates.mjs`, `web/updates.html`, `updates.js`, `updates.css`, `server/dev.mjs`, `netlify.toml`, tests.

**Interfaces:** `/api/updates/admin/*` uses a separate admin bearer token; `/api/updates/device/:id` uses a per-device bearer token. Public temperature API remains unchanged. Commands expire after 10 minutes, claim once using conditional writes and return status via heartbeat.

- [x] Test disabled/missing/wrong credentials, origin checks, oversized requests, stale devices, concurrent commands/claims, expiry and audit/status reporting.
- [x] Add device pairing/revocation, version/status panel and explicit update command button; keep disabled without signed release/online compatible agent.
- [x] Run Node and browser tests, including mobile layout.

### Task 4: Delivery and evidence

**Files:** README, CHANGELOG, Windows handoff/install and verification/update docs.

- [x] Run Python/Node/browser checks and review diff for secrets and operations outside scope.
- [x] Push reviewed source and run Windows build/install/update recovery verification; inspect downloadable artifacts with release-artifact-review.
- [x] Publish verified installer/portable/signed manifest and deploy web only after auth and agent tests pass.
- [x] Reopen deployed assets/API, distinguish bootstrap field install and real source tests still pending.
