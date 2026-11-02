# Collection Interval Implementation Plan

> **Execution:** Follow the project instructions and existing user authorization. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set server recording and dashboard polling intervals on the homepage to reduce Netlify usage.

**Architecture:** Store one public site setting with revision checks. Supported collectors fetch it at startup and every five minutes, retain the last valid setting offline, and report the actual applied interval with real records. The dashboard follows the same interval and reuses recent reads for voice. Reduce idle update heartbeat traffic to five minutes with compatible online detection.

**Tech Stack:** Existing Python collector, Node/Netlify Blobs API, vanilla browser JS, pytest, Node test, Playwright.

**Spec:** User request in this chat on 2026-11-02: change the temperature recording interval from the homepage because TC-06 Netlify usage is high.

## Global Constraints

- Public temperature API, no new login or keys; no PLC/HMI operations.
- Integer interval 30–3600 seconds; default 60 until explicitly saved. Recommend 300 seconds.
- Preserve OCR confirmation, null failure records, first good/recovery saves, immutable history and original timestamps.
- Keep the existing 150-second freshness/voice policy even when records are spaced farther apart.
- Publish only to the existing TC-06 Netlify site. Field collector installation requires the new Windows build and is reported separately.

## Review Focus

- Invalid, noninteger, out of range settings must not change scheduling.
- Concurrent browser settings edits must return conflict and preserve the winner.
- Offline/restart must retain a validated setting for the same server only.
- Lengthening/shortening intervals must re-anchor to the last save without creating missed records.
- Voice, hidden pages and graph polling must not bypass the selected interval; old collectors must show unsupported/unconfirmed status.

### Task 1: Public settings API and schedule

**Files:** `server/collection.mjs`, `server/api.mjs`, `collector/tc06/collection.py`, `collector/tc06/worker.py`, `collector/tc06/recovery.py`, `collector/tc06/updates.py`, `server/updates.mjs`, `tests/collection.test.mjs`, `tests/test_collection.py`.

**Interfaces:** `/api/settings` GET/POST `{interval_seconds,revision,updated_at}`; record optional `record_interval_seconds`, `collector_version`; `Recovery.set_interval(seconds)`; 300-second collector settings and idle update polling.

- [ ] Add validation, revision conflict, applied-record metadata and offline/scheduling tests; run them.
- [ ] Implement settings storage/cache, collector sync/cache, re-anchored recording schedule and compatible heartbeat expiry.
- [ ] Run Python and Node suites.

### Task 2: Homepage and release

**Files:** `web/collection.js`, `web/index.html`, `web/app.js`, `web/style.css`, `web/sw.js`, `web/updates.js`, `server/dev.mjs`, `tests/collection.spec.mjs`, version and user/verification documentation.

**Interfaces:** `TC06Collection.observe(data)`, `.seconds`, `.label`; homepage form with custom seconds and expected records/day, separate saved/applied feedback.

- [ ] Add browser tests for save/reload, validation/conflict/failure, reduced polling/voice, and small-screen layout.
- [ ] Implement the form and interval-based polling with explicit manual refresh; update docs/version.
- [ ] Run browser suite; inspect screenshots; build and inspect Windows artifacts with the existing workflow.
- [ ] Publish the website and verified signed Windows release; confirm live setting reads and supported assets without synthetic production temperature uploads or installing on a field PC.
