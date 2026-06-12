# Always-on telemetry with informational notice

**Date:** 2026-06-12
**Status:** Approved

## Goal

Telemetry (usage analytics + crash reporting) changes from opt-in to always-on
in packaged builds, with no opt-out. The first-run consent dialog becomes a
purely informational notice — no toggle, just a short explanation and a small
link to the privacy page (`https://cate.cero-ai.com/privacy`). The notice is
shown once to every user: on fresh install, and once to every existing user
when they update into the release that ships this change (regardless of their
previous opt-in/opt-out state).

Dev builds and `CATE_E2E` test runs are unaffected: telemetry stays off there.

## Mechanism: notice version

- New constant in `src/shared/types.ts`:
  `TELEMETRY_NOTICE_VERSION = 2`
  (version 1 is implicitly the old opt-in dialog era; bump this constant
  whenever the privacy policy materially changes and every user should see the
  notice again once).
- New setting `telemetryNoticeAcknowledgedVersion: number`, default `0`, added
  to `AppSettings`, the defaults, and the settings schema in
  `src/main/settingsFile.ts`.
- The notice dialog shows whenever
  `telemetryNoticeAcknowledgedVersion < TELEMETRY_NOTICE_VERSION` (after
  renderer settings have loaded). Dismissing it writes
  `telemetryNoticeAcknowledgedVersion = TELEMETRY_NOTICE_VERSION`.

## Changes by area

### Shared types / settings

- Add the constant and the new setting as above.
- The old keys `telemetryConsentDecided`, `crashReportingEnabled`, and
  `usageAnalyticsEnabled` remain in the schema so existing `settings.json`
  files load cleanly, but nothing reads them anymore. They can be removed in a
  later release.

### Main process

- `src/main/analytics.ts` — `isEnabled()` becomes: enabled iff
  `app.isPackaged === true` (the existing `CATE_E2E` handling keeps telemetry
  off in E2E runs). No settings lookups.
- `src/main/sentry.ts` — initialize unconditionally at startup when packaged
  and a DSN is present; no longer deferred behind consent.
- The deferred-startup-telemetry mechanism (`fireStartupTelemetry()` being
  held until consent) goes away; startup events fire immediately on init.
- Delete the grandfather clause in `src/main/index.ts` (~lines 220–231) that
  auto-marked old users as consented-with-everything-off.
- Update the `CATE_E2E` bypass in `src/main/index.ts` to pre-set
  `telemetryNoticeAcknowledgedVersion = TELEMETRY_NOTICE_VERSION` (instead of
  the old consent flags) so the notice modal never interferes with E2E runs.
- `src/main/lifecycle/telemetry.ts` — the consent IPC handler is replaced by
  an acknowledge handler that writes
  `telemetryNoticeAcknowledgedVersion = TELEMETRY_NOTICE_VERSION`. The IPC
  channel is renamed accordingly (e.g. `TELEMETRY_ACKNOWLEDGE_NOTICE`) in
  `src/shared/ipc-channels.ts` and the preload bridge.

### Renderer

- `src/renderer/dialogs/WelcomeDialog.tsx` — keeps the takeover-card layout;
  loses the toggle. Content: short copy stating that Cate collects anonymous
  usage data and crash reports to improve the app, a small link to
  `https://cate.cero-ai.com/privacy`, and a single "Continue" button that
  calls the acknowledge IPC.
- Show condition: settings loaded &&
  `telemetryNoticeAcknowledgedVersion < TELEMETRY_NOTICE_VERSION`.
- `src/renderer/onboarding/OnboardingTour.tsx` — its show condition switches
  from `consentDecided` to the same acknowledged-version check, so on a fresh
  install the tour still waits for the notice dialog to be dismissed.
- `src/renderer/settings/GeneralSettings.tsx` — remove both telemetry toggles
  ("Send crash reports", "Send anonymous usage data"). Replace with a one-line
  static note that anonymous usage data and crash reports are collected, with
  the same privacy link, so the privacy page stays discoverable after the
  dialog is gone.

## User-state matrix

| User state before update           | After updating / installing this release |
|------------------------------------|-------------------------------------------|
| Fresh install                      | Sees notice once; telemetry on            |
| Existing, previously opted in      | Sees notice once; telemetry on            |
| Existing, previously opted out     | Sees notice once; telemetry on            |
| Existing, grandfathered (auto-off) | Sees notice once; telemetry on            |
| Dev build (not E2E)                | Sees notice once (harmless); telemetry off |
| `CATE_E2E` run                     | No notice (bypass pre-sets the key); telemetry off |

Note: telemetry being "on" is independent of the notice being acknowledged —
the notice is informational, not a gate. In packaged builds telemetry is
active from startup.

## Testing

- `isEnabled()` returns true when packaged, false in dev and under `CATE_E2E`.
- Notice dialog show condition: shown when acknowledged version is 0 or below
  the constant; hidden once acknowledged.
- Acknowledge IPC writes `telemetryNoticeAcknowledgedVersion` correctly.
- OnboardingTour ordering still holds (tour only after notice dismissed).
- Update or remove existing tests that reference the removed consent flags
  and grandfather clause.

## Out of scope

- Removing the legacy settings keys from the schema (later release).
- Any changes to what events are collected or the analytics endpoint.
- Legal/GDPR assessment of mandatory telemetry (product decision; flagged
  during design).
