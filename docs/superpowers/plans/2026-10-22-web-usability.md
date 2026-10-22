# TC-06 Web Usability Implementation Plan

> **Execution:** Follow the project instructions and existing user authorization. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing TC-06 homepage recover from connection/settings failures and keep TV controls and CSV downloads usable.

**Architecture:** Keep the existing plain JavaScript dashboard and public API. Improve scoped interactions and defensive loading, and correct CSV export encoding without changing stored records or collector behavior.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js, Playwright, Netlify Functions.

**Spec:** User request on 2026-10-22; `AGENTS.md`, existing state/voice policies in `README.md`.

## Global Constraints

- Preserve public anonymous temperature reads/uploads, 30 Korean-date retention days, and 150-second fresh reading policy.
- Preserve separate measured/estimated/held/fallback states, original timestamps, gaps, and voice suppression.
- Keep Windows, updater authentication, credentials, and field controls unchanged.
- Never send synthetic temperatures to production or commit real readings/screenshots.

## Design

Keep the existing operational palette: background #080f18, panel #0c1723, text #edf4f9, muted #b1c4d1, accent #55e5b6, warning #ffbd59. Retain system Korean sans type and tabular numerals. Preserve browser-selected display colors. Add compact refresh feedback beside controls, and inline download errors next to the date selector. Visible keyboard focus and menu focus retention serve TV operation. Do not redesign the main temperature display or add decorative cards.

`temperature/status → actions + refresh feedback → folded settings/download`

Review: this is an existing field monitor; a large number and quiet controls are intentional. Use the established layout instead of a new landing-page treatment.

## Review Focus

- A focused TV menu must remain available beyond five seconds and arrow keys must reach buttons.
- Concurrent manual/automatic refreshes must share one latest request and always restore controls after failure.
- Null/non-object stored settings must not prevent the first API read in any mode.
- Export failure must preserve the homepage and held reading; invalid/expired dates must be explained inline.
- CSV quotes, newlines, and formula-like text must export safely without changing stored values or numeric temperatures.

### Task 1: TV navigation and immediate refresh

**Files:** `web/app.js`, `web/index.html`, `web/style.css`, `tests/navigation.spec.mjs`.
**Interfaces:** Existing `refresh()` remains a shared Promise; new `#refresh-latest`, `#display-refresh`, `#refresh-status` expose refresh to users.

- [x] Add regression tests for keyboard focus retention, arrow/Enter navigation, refresh de-duplication and failure/recovery.
- [x] Add refresh actions and accessible progress/results; preserve existing reading/voice state.
- [x] Keep focused menu open; retain five-second auto-hide for unfocused pointer use.

### Task 2: Resilient graph settings

**Files:** `web/graph.js`, `tests/graph-resilience.spec.mjs`.
**Interfaces:** `new TC06Graph.Graph(now)` must tolerate invalid persisted JSON values; graph request sequencing stays intact.

- [x] Reproduce null/primitive saved settings and add first-read/graph regression checks.
- [x] Normalize saved settings to a plain object and inspect graph pending/failure behavior for additional confirmed issues.

### Task 3: Reliable CSV download and encoding

**Files:** `server/api.mjs`, `tests/api.test.mjs`, `web/app.js`, `web/index.html`, `tests/download.spec.mjs`.
**Interfaces:** `/api/history?day=YYYY-MM-DD` keeps existing CSV columns and attachment filename; download UI fetches the attachment without navigating away.

- [x] Add server tests for RFC CSV escaping and spreadsheet formula protection in text columns, preserving numeric values.
- [x] Add date bounds and inline progress/error/retry for browser CSV downloads.
- [x] Verify successful attachment and failed requests keep the dashboard visible.

### Task 4: Verify and publish

**Files:** `playwright.config.mjs`, `web/sw.js`, `README.md`, `docs/VERIFICATION.md`, this plan.

- [x] Include focused regression spec files, bump service worker cache, run `npm test`, `npm run test:web`, and `python -m pytest`.
- [x] Inspect local desktop/mobile screens and keyboard interactions with synthetic fixtures only.
- [ ] Commit scoped source/docs to GitHub and deploy the verified tree to the existing temperature-only Netlify site.
- [ ] Reopen production, compare deployed asset hashes, read public APIs, and document boundaries and deployment evidence.

