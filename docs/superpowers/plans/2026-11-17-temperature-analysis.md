# TC-06 temperature analysis

## Operator workflow

Open **온도 분석** from the normal or graph screen. Select a shift start date and a 12-hour shift. Korean local time defines day shift as 08:00 to 20:00 and night shift as 20:00 to 08:00 the next day. A date labels the day the shift starts. The first view uses the current shift. The hourly table and initial chart use that shift.

Switch the table between hours in the selected shift, calendar days, the selected shift across dates, and named time blocks across dates. The comparison period is one, seven, or thirty calendar dates ending at the selected date, clipped to the 30-day retention window. The running day and shift include measurements received so far. Each row shows measured average, minimum, maximum, measured count, failed count, and rapid rise and fall counts.

Default time blocks are lunch 11:20–12:00 and break 16:20–17:00. Dinner has empty start and end fields. A browser can store up to six named blocks. The operator may enter overlapping blocks or edit the default times. Each block starts and ends on the same calendar date.

A change qualifies when a continuous run of actual readings changes by at least the threshold within the specified time window. The initial choices are 5 °C and 5 minutes. For each new reading, compare with the lowest or highest preceding reading in the window. Overlapping windows from these same-direction candidates count as one event. The displayed measurement pair stays within the user-selected window, even if later candidates extend the group. An event counts at its start. Failed readings, missing readings, and a break in the expected cadence stop continuity. Without a comparable pair, the table shows a dash. Estimated and held readings stay out of the calculations.

A bar or table row opens its measured chart. Selecting a date keeps the chosen 12-hour shift. Selecting an event highlights it and makes a link to the original graph and selected measurement. The chart shows the last stored measurement in each minute. Choose 5- and 30-minute moving averages, 30-minute Bollinger bands, or MACD using 12/26/9 exponential averages. Indicators require a continuous run of measurements and restart after a gap.

## Implementation Plan

- [server/analysis.mjs](../../../server/analysis.mjs) reuses daily trend indexes and builds KST buckets, weighted-by-sample averages, shift and block counts, and selected-date minute series through the next 08:00 plus the configured event window, bounded by the server time. [server/api.mjs](../../../server/api.mjs) exposes the GET route. A date that has passed retention returns 410.
- [web/analysis.js](../../../web/analysis.js) manages the range form, table, comparative bars, and event requests. [web/index.html](../../../web/index.html) and [web/analysis.css](../../../web/analysis.css) provide the analysis view. [web/analysis-chart.js](../../../web/analysis-chart.js) draws the temperature and indicators within the selected time range, calculating from the underlying selected-day series before zooming.
- [web/graph.js](../../../web/graph.js) validates and pins the selected measurement link. The trend endpoint excludes its end timestamp, so the linked query ends one millisecond after the selected measurement. The live button returns to the current query.
- [tests/analysis.test.mjs](../../../tests/analysis.test.mjs) checks calendar and shift boundaries, weighted averages, failure and gaps, threshold overlap, custom blocks, legacy indexes and retention. [tests/analysis.spec.mjs](../../../tests/analysis.spec.mjs) checks navigation, table modes, indicator rendering, mobile width, event selection and the original graph.
