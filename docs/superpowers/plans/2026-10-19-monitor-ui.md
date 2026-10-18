# TC-06 monitor clarity Implementation Plan

> **Execution:** Follow the project instructions and existing user authorization. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement the approved priorities 1–3 across reading status, normal settings and graphs, and deploy the verified web changes.

**Architecture:** Keep the public temperature API, collector and update authentication unchanged. Render loading/good/estimated/held/fallback consistently from existing API timestamps and status. Add graph presentation preferences locally, independent of readings and measured statistics.

**Tech Stack:** Plain HTML/CSS/JavaScript, SVG, Web Audio, Node tests and Chrome Playwright.

**Spec:** User-approved priorities 1–3 in this chat; AGENTS.md reading/voice/retention constraints.

## Global Constraints

- Priority 4 is excluded: do not modify updates.html/js/css, updater, credentials or access.
- Preserve 38 only as explicitly labelled fallback; estimates and held values never use current-temperature speech.
- Preserve original capture time, raw failures, public API, 30-day policy and strict OCR.
- Fixed Korean female voice assets, no runtime OS voice or external service.
- Target/range are optional local reference guides, disabled initially, never equipment control.

## Design

Preserve the familiar navy monitoring surface: background #0a1119, panel #101e29, text #eaf4f7, muted #9cb0bd, received #55e5b6, caution #ffc46b. Use the existing Korean system font and tabular temperature digits. Centre the reading and keep status immediately adjacent; align controls and timestamp labels consistently. The large reading is purposeful for distant TV viewing. Avoid decorative redesign: collapse setup, use a separate labelled status strip for data quality, and keep plot marks free of failure symbols.

Normal: [asset / reading kind] [large reading] [age / connection / reason] [speech / navigation] [collapsed settings, policy, CSV].
Graph: [live reading + age / navigation] [time controls] [measured / failed / empty / estimated counts] [temperature plot + local tooltip] [labelled quality strip] [details / freshness].

## Review Focus

- Delayed first API response must not show a false outage or default temperature.
- Fallback speech must never use the actual-temperature introduction.
- Failed and missing intervals must not be temperature marks, including mixed aggregated bars.
- Invalid saved axis/reference settings must not hide or corrupt data or produce invalid SVG.
- Phone/TV layout and offline reload must retain disclosures and settings without overflow.

### Task 1: Shared status and fallback voice

**Files:** web/app.js, web/index.html, web/voice.js, web/voice/fallback.mp3, web/voice/manifest.json, scripts/build-number-voice.py, tests/voice.test.mjs, tests/web.spec.mjs.
**Interfaces:** readingView() returns loading/good/estimated/held/fallback; temperatureTokens(value, kind='good') and NumberVoice.say(value, volume, kind) use fallback introduction only for fallback.
- [x] Add delayed-first-response, cross-mode age and fallback-token checks; update existing expectations for explicit labels.
- [x] Implement loading state, shared kind/age/reason display and fallback phrase, retaining held/estimate silence.
- [x] Generate only the new fixed fallback phrase; verify manifest bytes and browser audio decode.

### Task 2: Compact normal page

**Files:** web/index.html, web/app.js, web/style.css, tests/web.spec.mjs.
**Interfaces:** settings-open opens settings-panel; existing settings-v2 storage stays compatible.
- [x] Test collapsed settings, navigation to setup and selected custom colour persistence.
- [x] Collapse settings/policy, consolidate palettes into existing selector and label numeric-only scope; retain CSV.
- [x] Verify normal/numeric mobile and TV layouts and keyboard navigation.

### Task 3: Graph quality, detail and reference controls

**Files:** web/graph.js, web/index.html, web/style.css, tests/web.spec.mjs.
**Interfaces:** Graph preferences saved separately in tc06-graph-view-v1; no API/schema or measured statistics changes.
- [x] Test separate quality strip (good/failed/mixed/empty and estimate overlay), distinct record counts and latest default selection.
- [x] Implement local tooltip, keyboard detail, auto/fixed axis and optional target/range with validation and clipping disclosure.
- [x] Test invalid preferences, fixed-axis clipping, no synthetic candles, resize, date changes and offline history.

### Task 4: Verification and publication

**Files:** web/sw.js, README.md, docs/VERIFICATION.md, this plan.
- [x] Bump web cache revision, cache fallback asset and document the web-only release.
- [x] Run Python, Node and Chrome suites; inspect synthetic local UI at 390×844, 887×1200 and 1920×1080.
- [x] Confirm excluded update files unchanged; commit/push and production deploy without changing environment variables.
- [x] Verify deployed assets, public API and live screen; distinguish Windows/field checks not performed.

## Completion

Runtime commit `fe9dc18`; production deploy `6ad4ead55eec95c6c0ccac9e`. Python 100, Node 53, Chrome 38 passed, plus the targeted final phone/desktop/TV layout check. Deployed web assets match the verified local files. Update-page bytes and authentication remain unchanged. Windows collector/HMI/TV field operation was not changed or validated by this web-only release.
