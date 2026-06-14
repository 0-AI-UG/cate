# Always-On Telemetry with Informational Notice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telemetry (usage analytics + Sentry) becomes always-on in packaged builds with no opt-out; the first-run consent dialog becomes an informational notice (no toggle, privacy link only) shown once per `TELEMETRY_NOTICE_VERSION` to every user — fresh installs and updaters alike.

**Architecture:** A `TELEMETRY_NOTICE_VERSION = 2` constant plus a persisted `telemetryNoticeAcknowledgedVersion` setting drive the notice dialog. Analytics/Sentry gating drops all settings checks and gates only on `app.isPackaged` (Sentry additionally honors an explicit `SENTRY_DSN` env override in dev). The old consent keys stay in the schema but are never read.

**Tech Stack:** Electron main/preload/renderer, React, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-always-on-telemetry-design.md`

**Conventions:**
- Run a single test file: `npx vitest run src/path/to/file.test.ts`
- Run everything: `npm test`
- Commit after every task. No Claude/AI attribution in commit messages (user rule).
- Some git-touching tests in this repo fail in a dirty dev tree — those failures are environmental (see CLAUDE.md); judge success by the tests related to your task plus no NEW failures elsewhere.

---

### Task 1: Shared types, defaults, and settings schema

**Files:**
- Modify: `src/shared/types.ts:1220-1230` (AppSettings privacy block), `src/shared/types.ts:1310-1314` (defaults)
- Modify: `src/main/settingsFile.ts:68-70` (schema)

- [ ] **Step 1: Add the constant and new setting to `src/shared/types.ts`**

Replace the Privacy block of `AppSettings` (lines 1220–1230) with:

```ts
  // Privacy
  /** DEPRECATED — no longer read anywhere. Telemetry is always on in packaged
   *  builds since notice v2. Kept in the schema so existing settings.json files
   *  load cleanly; remove in a later release. */
  crashReportingEnabled: boolean
  /** DEPRECATED — see crashReportingEnabled. */
  usageAnalyticsEnabled: boolean
  /** DEPRECATED — see crashReportingEnabled. */
  telemetryConsentDecided: boolean
  /** Highest TELEMETRY_NOTICE_VERSION the user has dismissed the telemetry
   *  notice (WelcomeDialog) for. The notice shows whenever this is below the
   *  current TELEMETRY_NOTICE_VERSION — on first install, and again for every
   *  existing user when the constant is bumped. Informational only — telemetry
   *  does not depend on it. */
  telemetryNoticeAcknowledgedVersion: number
```

Directly ABOVE the `export interface AppSettings` declaration, add:

```ts
/** Version of the telemetry/privacy notice. Bump when the privacy policy
 *  materially changes so every user sees the informational notice once more.
 *  v1 = the old opt-in consent dialog era; v2 = always-on telemetry notice. */
export const TELEMETRY_NOTICE_VERSION = 2
```

In `DEFAULT_SETTINGS` (lines 1310–1314), replace the privacy block with:

```ts
  // Privacy. The three legacy consent flags are deprecated (no longer read);
  // telemetry is always on in packaged builds. The acknowledged notice version
  // starts at 0 so every fresh install and every updater sees the notice once.
  crashReportingEnabled: true,
  usageAnalyticsEnabled: true,
  telemetryConsentDecided: false,
  telemetryNoticeAcknowledgedVersion: 0,
```

- [ ] **Step 2: Add the key to the settings schema**

In `src/main/settingsFile.ts` after line 70 (`telemetryConsentDecided: 'boolean',`) add:

```ts
  telemetryNoticeAcknowledgedVersion: 'number',
```

- [ ] **Step 3: Verify the project still typechecks and settings tests pass**

Run: `npx vitest run src/main/settingsFile.test.ts` (if that file doesn't exist, run `npx vitest run src/main`)
Expected: PASS (no schema/type mismatches).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/main/settingsFile.ts
git commit -m "feat(telemetry): add TELEMETRY_NOTICE_VERSION and acknowledged-version setting"
```

---

### Task 2: Analytics always-on in packaged builds

**Files:**
- Modify: `src/main/analytics.ts:226-230` (`isEnabled`), `src/main/analytics.ts:202-206` (skip log), header comment lines 1–7
- Rewrite test: `src/main/analyticsConsent.test.ts` → `src/main/analyticsEnabled.test.ts`

- [ ] **Step 1: Rewrite the gating test to the new behavior (failing first)**

```bash
git mv src/main/analyticsConsent.test.ts src/main/analyticsEnabled.test.ts
```

Replace the FULL contents of `src/main/analyticsEnabled.test.ts` with:

```ts
// =============================================================================
// Analytics gating — telemetry is always on in packaged builds (no settings
// gate, no opt-out) and always OFF in dev/test builds. The legacy consent
// settings must have no effect either way.
// =============================================================================

import { describe, expect, test, vi, beforeEach } from 'vitest'

const settings: Record<string, unknown> = {}
const netRequest = vi.fn()
const electronApp = {
  getVersion: () => '0.0.0-test',
  getLocale: () => 'en',
  isPackaged: false,
  getPath: () => '/tmp',
}

vi.mock('electron', () => ({
  app: electronApp,
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  net: { request: netRequest },
}))
vi.mock('./store', () => ({ getSettingSync: (k: string) => settings[k] }))
vi.mock('./appContext', () => ({
  getCommonContext: () => ({
    install_id: 'test', app_version: '0.0.0-test', platform: 'darwin', arch: 'arm64',
    electron_version: '0', node_version: '0', chrome_version: '0', locale: 'en',
    is_packaged: false, os_release: 'test',
  }),
}))
vi.mock('./logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))

const { sendEvent } = await import('./analytics')

beforeEach(() => {
  netRequest.mockClear()
  for (const k of Object.keys(settings)) delete settings[k]
  electronApp.isPackaged = false
})

describe('analytics gating', () => {
  test('no send in dev builds, regardless of legacy consent settings', async () => {
    settings.telemetryConsentDecided = true
    settings.usageAnalyticsEnabled = true
    const ok = await sendEvent('app_start')
    expect(ok).toBe(false)
    expect(netRequest).not.toHaveBeenCalled()
  })

  test('sends in packaged builds with no settings at all', async () => {
    electronApp.isPackaged = true
    // netRequest is a bare stub (no callbacks), so the post will fail and the
    // event buffers — the point is the gate lets it reach the network.
    await sendEvent('app_start')
    expect(netRequest).toHaveBeenCalledTimes(1)
  })

  test('legacy opt-out settings do NOT disable sending in packaged builds', async () => {
    electronApp.isPackaged = true
    settings.telemetryConsentDecided = false
    settings.usageAnalyticsEnabled = false
    settings.crashReportingEnabled = false
    await sendEvent('app_start')
    expect(netRequest).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/analyticsEnabled.test.ts`
Expected: FAIL — tests 2 and 3 fail because `isEnabled()` still reads the consent settings (no network call happens).

- [ ] **Step 3: Implement the new gate in `src/main/analytics.ts`**

Replace `isEnabled` (lines 226–230) with:

```ts
function isEnabled(): boolean {
  // Telemetry is always on in packaged builds (no settings gate, no opt-out).
  // Dev and E2E builds (unpackaged) never send. The informational telemetry
  // notice (WelcomeDialog) is not a gate — it only records acknowledgement.
  return app.isPackaged
}
```

(`app` is already imported from `electron` in this file.)

In `sendEvent` (line ~204), change the skip log to match:

```ts
    log.info('[analytics] %s skipped (unpackaged build)', name)
```

Update the file-header comment (around line 4): replace the sentence describing the consent gate (`(telemetryConsentDecided) AND the usageAnalyticsEnabled toggle — nothing …`) with wording like: "Events send only from packaged builds — telemetry is always on there; dev/E2E builds never send."

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/analyticsEnabled.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/analytics.ts src/main/analyticsEnabled.test.ts
git commit -m "feat(telemetry): analytics always on in packaged builds, off in dev"
```

---

### Task 3: Sentry always-on; remove the live crash-reporting toggle

**Files:**
- Modify: `src/main/sentry.ts:81-115` (`initSentry`, delete `setCrashReportingEnabled`), header comment line 9
- Modify: `src/main/store.ts:144-153` (delete live-toggle block)

- [ ] **Step 1: Rewrite `initSentry` in `src/main/sentry.ts`**

Replace the whole `initSentry` function (lines 81–93) with:

```ts
export function initSentry(): void {
  // Telemetry is always on in packaged builds (no opt-out). In dev, init only
  // when a DSN was explicitly provided via the environment (opt-in for
  // debugging the Sentry pipeline itself).
  if (!app.isPackaged && !process.env.SENTRY_DSN) {
    log.info('[sentry] dev build without SENTRY_DSN; skipping init')
    return
  }
  actuallyInit()
}
```

Delete the entire `setCrashReportingEnabled` function (lines 95–115, including its doc comment).

Remove the now-unused import if `getSettingSync` is no longer referenced in this file: delete `import { getSettingSync } from './store'` (line 15).

In the header comment, change line 9 from `// When the DSN is empty or the user has opted out, init is a no-op.` to `// When the DSN is empty, init is a no-op.`

- [ ] **Step 2: Remove the live-toggle block in `src/main/store.ts`**

Delete lines 144–153 (the comment `// Live-toggle Sentry when the crash-reporting setting flips…` and the whole `if (key === 'crashReportingEnabled') { … }` block). Leave the `betaUpdatesEnabled` block that follows untouched.

- [ ] **Step 3: Verify nothing still references the deleted function**

Run: `grep -rn "setCrashReportingEnabled" src/`
Expected: no output.

Run: `npx vitest run src/main`
Expected: PASS (no new failures vs. before the change).

- [ ] **Step 4: Commit**

```bash
git add src/main/sentry.ts src/main/store.ts
git commit -m "feat(telemetry): initialize Sentry unconditionally in packaged builds"
```

---

### Task 4: Acknowledge-notice IPC + startup wiring

**Files:**
- Modify: `src/shared/ipc-channels.ts:158`
- Rewrite: `src/main/lifecycle/telemetry.ts`
- Modify: `src/main/index.ts:50, 213-250`
- Modify: `src/preload/index.ts:183, 489`
- Modify: `src/shared/electron-api.d.ts:831-833`

- [ ] **Step 1: Rename the IPC channel**

In `src/shared/ipc-channels.ts` line 158, replace:

```ts
export const TELEMETRY_SET_CONSENT = 'telemetry:setConsent'
```

with:

```ts
export const TELEMETRY_ACKNOWLEDGE_NOTICE = 'telemetry:acknowledgeNotice'
```

- [ ] **Step 2: Rewrite `src/main/lifecycle/telemetry.ts`**

Replace the FULL file contents with:

```ts
import { BrowserWindow, ipcMain } from 'electron'
import log from '../logger'
import { setSettingsFromMain } from '../store'
import { trackAppStart, checkAndReportUpdate } from '../analytics'
import { TELEMETRY_ACKNOWLEDGE_NOTICE } from '../../shared/ipc-channels'
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'

// Fire the first-run/version-change analytics + app_start. Telemetry is always
// on in packaged builds; the sends themselves are gated inside analytics.ts
// (dev/E2E builds never send), so there is nothing to defer here anymore.
export function fireStartupTelemetry(mainWin: BrowserWindow): void {
  checkAndReportUpdate(mainWin).catch((err) => log.warn('Update detection failed:', err))
  trackAppStart()
}

// The renderer's telemetry notice (WelcomeDialog) was dismissed — record which
// notice version the user has seen so it isn't shown again until the constant
// is bumped. Purely informational; telemetry does not depend on it.
export function registerTelemetryNoticeHandler(): void {
  ipcMain.handle(TELEMETRY_ACKNOWLEDGE_NOTICE, async () => {
    await setSettingsFromMain({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION })
  })
}
```

- [ ] **Step 3: Update `src/main/index.ts`**

Line 50, replace the import:

```ts
import { fireStartupTelemetry, registerTelemetryNoticeHandler } from './lifecycle/telemetry'
```

Add `TELEMETRY_NOTICE_VERSION` to the existing import from `'../shared/types'` (if `index.ts` has no import from `../shared/types`, add `import { TELEMETRY_NOTICE_VERSION } from '../shared/types'` next to the other shared imports).

Replace the grandfather block (lines 213–231, comment included) with:

```ts
// Scope the onboarding tour to genuine first installs. Anyone who has launched
// Cate before is marked past it, so an update never replays the tour. The
// telemetry notice (WelcomeDialog) intentionally has NO such clause — every
// user whose acknowledged notice version is below TELEMETRY_NOTICE_VERSION
// sees it once, updaters included.
if (hasRunBefore()) {
  if (!getSettingSync('onboardingCompleted')) {
    void setSettingsFromMain({ onboardingCompleted: true })
  }
}
```

Replace the E2E block (lines 233–239) body with:

```ts
// Under Playwright the profile is a fresh tmpdir, which would otherwise trigger
// the telemetry notice + onboarding takeover and cover the canvas the specs
// drive. Mark both as already handled so e2e starts on a clean canvas. Runs
// before the renderer queries settings, so the dialogs never flash.
if (IS_E2E) {
  void setSettingsFromMain({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION, onboardingCompleted: true })
}
```

Replace the comment above `initSentry()` (lines 241–243) with:

```ts
// Initialize Sentry as early as possible — before any IPC handlers or windows.
// Always on in packaged builds; no-op in dev unless SENTRY_DSN is set.
```

Replace the comment + call at lines 247–250 with:

```ts
// Telemetry-notice acknowledgement from the renderer (WelcomeDialog).
registerTelemetryNoticeHandler()
```

- [ ] **Step 4: Update preload and the API type**

`src/preload/index.ts` line 183: replace `TELEMETRY_SET_CONSENT,` with `TELEMETRY_ACKNOWLEDGE_NOTICE,` in the import list.

`src/preload/index.ts` line 489: replace

```ts
  setTelemetryConsent: makeInvoker<'setTelemetryConsent'>(TELEMETRY_SET_CONSENT),
```

with:

```ts
  acknowledgeTelemetryNotice: makeInvoker<'acknowledgeTelemetryNotice'>(TELEMETRY_ACKNOWLEDGE_NOTICE),
```

`src/shared/electron-api.d.ts` lines 831–833: replace the `setTelemetryConsent` entry (doc comment included) with:

```ts
  /** Record that the telemetry notice (WelcomeDialog) was acknowledged for the
   *  current TELEMETRY_NOTICE_VERSION. Informational only — telemetry is always
   *  on in packaged builds and does not depend on this. */
  acknowledgeTelemetryNotice(): Promise<void>
```

- [ ] **Step 5: Verify no stale references remain**

Run: `grep -rn "TELEMETRY_SET_CONSENT\|setTelemetryConsent\|registerTelemetryConsentHandler" src/`
Expected: only hits in `src/renderer/dialogs/WelcomeDialog.tsx` and its test (reworked in Task 5).

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/lifecycle/telemetry.ts src/main/index.ts src/preload/index.ts src/shared/electron-api.d.ts
git commit -m "feat(telemetry): replace consent IPC with notice acknowledgement"
```

---

### Task 5: Rework WelcomeDialog into an informational notice

**Files:**
- Modify: `src/renderer/dialogs/WelcomeDialog.tsx`
- Modify: `src/renderer/dialogs/WelcomeDialog.test.tsx`

- [ ] **Step 1: Rewrite the test to the new behavior (failing first)**

Replace the FULL contents of `src/renderer/dialogs/WelcomeDialog.test.tsx` with:

```tsx
// =============================================================================
// WelcomeDialog — first-run welcome + telemetry notice. Shows until the current
// TELEMETRY_NOTICE_VERSION is acknowledged; Continue records the acknowledgement
// (informational only — there is no opt-in/opt-out choice).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WelcomeDialog } from './WelcomeDialog'
import { useSettingsStore } from '../stores/settingsStore'
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'

let host: HTMLDivElement
let root: Root
const acknowledge = vi.fn(() => Promise.resolve())

function clickButton(match: (b: HTMLButtonElement) => boolean): void {
  const btn = [...host.querySelectorAll('button')].find(match as (b: Element) => boolean) as HTMLButtonElement
  if (!btn) throw new Error('button not found')
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  acknowledge.mockClear()
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    settingsSet: vi.fn(() => Promise.resolve()),
    acknowledgeTelemetryNotice: acknowledge,
    trackLinkClick: vi.fn(),
    openExternalUrl: vi.fn(),
  }
  useSettingsStore.setState({ _loaded: true, telemetryNoticeAcknowledgedVersion: 0 } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('WelcomeDialog', () => {
  it('is hidden once the current notice version is acknowledged', () => {
    useSettingsStore.setState({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION } as never)
    act(() => root.render(<WelcomeDialog />))
    expect(host.textContent).toBe('')
  })

  it('shows for users below the current notice version (fresh install or update)', () => {
    act(() => root.render(<WelcomeDialog />))
    expect(host.textContent).toContain('Welcome to Cate')
    expect(host.textContent).toContain('Privacy Policy')
    // No opt-in choice anymore.
    expect(host.querySelector('[role="switch"]')).toBeNull()
  })

  it('Continue acknowledges the notice and dismisses after the fade', () => {
    vi.useFakeTimers()
    act(() => root.render(<WelcomeDialog />))
    clickButton((b) => b.textContent?.trim() === 'Continue')
    expect(acknowledge).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(350) })
    expect(useSettingsStore.getState().telemetryNoticeAcknowledgedVersion).toBe(TELEMETRY_NOTICE_VERSION)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/dialogs/WelcomeDialog.test.tsx`
Expected: FAIL (component still renders the switch and calls `setTelemetryConsent`).

- [ ] **Step 3: Rework `src/renderer/dialogs/WelcomeDialog.tsx`**

Make these changes:

1. Header comment (lines 1–9) — replace with:

```tsx
// =============================================================================
// WelcomeDialog — first-run welcome + telemetry notice, in one screen.
//
// Shown once per TELEMETRY_NOTICE_VERSION, in the main window, on a (plain)
// first-run canvas before the guided tour — so fresh installs see it once, and
// existing users see it once more whenever the notice version is bumped (e.g.
// the v2 switch to always-on telemetry). Purely informational: there is no
// opt-in choice, just a privacy-policy link. Uses the app's surface tokens +
// radius (matching the ⌘K palette) and the blue accent, with a logo header.
// =============================================================================
```

2. Imports: remove `useState` usage for the toggle only (keep `useState` — still used for `saving`/`exiting`), remove `Check` from the phosphor import (keep `EnvelopeSimple`), and add:

```tsx
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'
```

3. Component state and gate — replace lines 40–47 with:

```tsx
  const acknowledgedVersion = useSettingsStore((s) => s.telemetryNoticeAcknowledgedVersion)
  const loaded = useSettingsStore((s) => s._loaded)

  const [saving, setSaving] = useState(false)
  const [exiting, setExiting] = useState(false)

  if (!loaded || acknowledgedVersion >= TELEMETRY_NOTICE_VERSION) return null
```

4. `onContinue` — replace lines 49–70 with:

```tsx
  const onContinue = (): void => {
    if (saving) return
    setSaving(true)
    setExiting(true)
    // Persist now (fire-and-forget; doesn't touch the local store gate that
    // keeps this dialog mounted).
    try {
      void window.electronAPI.acknowledgeTelemetryNotice()
    } catch (err) {
      log.warn('[telemetry] notice acknowledgement failed:', err)
    }
    // Let the fade-out play before flipping the local setting — that unmounts
    // this dialog and hands off to the tour (which fades in on its own), so the
    // transition is a soft dissolve rather than a harsh cut.
    window.setTimeout(() => {
      useSettingsStore.setState({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION })
    }, 320)
  }
```

5. Consent row — replace the block from the comment `{/* Consent — a single centered line the user can toggle. */}` through its closing `</div>` (lines 154–180) with:

```tsx
          {/* Telemetry notice — informational only, no choice. */}
          <p className="text-center text-[12px] text-secondary leading-relaxed">
            Cate collects anonymous usage data and crash reports to improve the app.{' '}
            <span
              onClick={() => openLink(PRIVACY_URL, 'privacy_policy')}
              className="text-blue-400 hover:text-blue-300 font-medium cursor-pointer"
            >
              Privacy Policy
            </span>
          </p>
```

Everything else (header image, community buttons, Continue button) stays as-is.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/dialogs/WelcomeDialog.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/dialogs/WelcomeDialog.tsx src/renderer/dialogs/WelcomeDialog.test.tsx
git commit -m "feat(telemetry): turn first-run consent dialog into informational notice"
```

---

### Task 6: OnboardingTour waits on the notice acknowledgement

**Files:**
- Modify: `src/renderer/onboarding/OnboardingTour.tsx:134-146`
- Modify: `src/renderer/onboarding/OnboardingTour.test.tsx:43-58`

- [ ] **Step 1: Update the test (failing first)**

In `src/renderer/onboarding/OnboardingTour.test.tsx`:

Add to the imports at the top of the file:

```tsx
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'
```

Replace line 44 with:

```tsx
  useSettingsStore.setState({ _loaded: true, telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION, onboardingCompleted: false } as never)
```

Replace the first test (lines 54–58) with:

```tsx
  it('stays hidden until the telemetry notice is acknowledged', () => {
    setState({ telemetryNoticeAcknowledgedVersion: 0 })
    act(() => root.render(<OnboardingTour />))
    expect(host.textContent).toBe('')
  })
```

(If `setState`'s parameter type rejects the new key, it is a local helper wrapping `useSettingsStore.setState` — adjust the helper's type to `Partial<SettingsStore>` or cast `as never` like the beforeEach does.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/onboarding/OnboardingTour.test.tsx`
Expected: FAIL — the tour still keys off `telemetryConsentDecided`, which defaults to `false`, so it never shows.

- [ ] **Step 3: Update the component**

In `src/renderer/onboarding/OnboardingTour.tsx`, add to the imports:

```tsx
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'
```

Replace line 136 with:

```tsx
  const noticeAcknowledgedVersion = useSettingsStore((s) => s.telemetryNoticeAcknowledgedVersion)
```

Replace lines 144–146 with:

```tsx
  // Show only after settings load AND the telemetry notice was acknowledged
  // (so the notice goes first), and only until the tour is completed/skipped.
  const active = loaded && noticeAcknowledgedVersion >= TELEMETRY_NOTICE_VERSION && !completed
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/onboarding/OnboardingTour.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/onboarding/OnboardingTour.tsx src/renderer/onboarding/OnboardingTour.test.tsx
git commit -m "feat(telemetry): gate onboarding tour on notice acknowledgement"
```

---

### Task 7: Remove the Settings toggles, add a static privacy note

**Files:**
- Modify: `src/renderer/settings/GeneralSettings.tsx`

- [ ] **Step 1: Replace the two telemetry toggles with a static note**

In `src/renderer/settings/GeneralSettings.tsx`, replace the two `SettingRow` blocks for "Send crash reports" (lines 15–20) and "Send anonymous usage data" (lines 21–26) with:

```tsx
      <SettingRow
        label="Privacy"
        description="Cate collects anonymous usage data and crash reports to improve the app. No file paths, project names, or personal data."
      >
        <button
          onClick={() => window.electronAPI?.openExternalUrl?.('https://cate.cero-ai.com/privacy')}
          className="text-blue-400 hover:text-blue-300 text-[12px] font-medium whitespace-nowrap"
        >
          Privacy Policy
        </button>
      </SettingRow>
```

- [ ] **Step 2: Verify there are no tests pinned to the old toggles, and the renderer suite passes**

Run: `grep -rn "Send crash reports\|Send anonymous usage data" src/`
Expected: no output.

Run: `npx vitest run src/renderer/settings` (skip if no test files exist there — `ls src/renderer/settings/*.test.*` to check)
Expected: PASS or no test files.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/settings/GeneralSettings.tsx
git commit -m "feat(telemetry): replace settings toggles with static privacy note"
```

---

### Task 8: Final sweep — leftovers, full suite, build

**Files:** none new — verification only.

- [ ] **Step 1: Verify the legacy flags are never read**

Run: `grep -rn "telemetryConsentDecided\|usageAnalyticsEnabled\|crashReportingEnabled" src/ | grep -v "shared/types.ts" | grep -v "settingsFile.ts"`
Expected: no output. If anything shows up (a consumer was missed), fix it the same way the equivalent site was fixed in Tasks 2–6 (always-on: delete the read; notice gate: switch to `telemetryNoticeAcknowledgedVersion >= TELEMETRY_NOTICE_VERSION`).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS, except possibly the environmental git-touching tests noted in CLAUDE.md (compare against `git stash && npm test` baseline only if unsure — otherwise judge by whether failures mention git branches/working-tree state).

- [ ] **Step 3: Production build sanity check**

Run: `npm run build`
Expected: completes without type errors.

- [ ] **Step 4: Commit any sweep fixes**

```bash
git add -A
git commit -m "chore(telemetry): clean up remaining consent-flag references"
```

(Skip the commit if Step 1 found nothing and the tree is clean.)
