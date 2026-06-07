# Update Install Re-architecture & Trapped-User Rescue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Update & Restart" install reliably (macOS-first), stop silently trapping users on broken versions, and give already-trapped users an in-app escape — by making the update installer the single owner of the install-quit path instead of entangling it with the generic quit machinery.

**Architecture:** Introduce one module (`src/main/updateInstaller.ts`) that owns the entire install sequence: macOS self-update eligibility pre-flight (App Translocation / not-in-/Applications), a single session flush, deterministic teardown, `quitAndInstall`, and a watchdog that surfaces failure instead of leaving a dead button. The generic `before-quit`/`will-quit` handlers in `index.ts` become pure no-ops while an install is in progress (the installer already did teardown), removing the double-flush, the terminal-confirmation dialog interception, and the `reallyExit` ambiguity. A macOS startup nudge offers move-to-/Applications so future updates can ever work. The renderer button always exposes a recoverable affordance (manual download) on `error`/`manual`/stall instead of vanishing.

**Tech Stack:** Electron 41, electron-updater 6.8.3, electron-builder 26, TypeScript, Vitest, React + Zustand (renderer).

---

## Pre-requisite (owned by the human, not a code task): confirm the funnel

Before/while implementing, pull the analytics funnel to confirm platform split and quantify the trap. Events already emitted (see `src/main/analytics.ts`):

- `app_start` — props include `version`, `platform`, `arch`
- `update_download_clicked` — `version`
- `update_install_clicked` — `version`
- `app_updated` — `from_version`, `to_version`

**Key metric:** for each `update_install_clicked {version=V, platform=P}`, was there a subsequent `app_updated {from=V}` or `app_start {version>V}` from the same install within ~10 min? The non-conversion rate, split by `platform`, tells us how much of the trap is macOS (expected: high, App Translocation) vs Windows (NSIS spawn) vs the terminal-dialog era (≤ v1.2.0, all platforms). This validates prioritization; it does not block macOS work, which is already a confirmed problem.

---

## Background: confirmed findings (why this plan exists)

- **Release pipeline is healthy** — every release has correct `latest-mac.yml` (path → `.zip`), both mac `.zip`s, blockmaps, `latest.yml`, `latest-linux.yml`; signing/notarize configured. The trap is **client-side**, so re-publishing cannot rescue trapped users; the rescue must be the (data-safe) manual reinstall, nudged in-app.
- **B1 — macOS App Translocation (high confidence):** no `moveToApplications`/translocation handling exists. Running from the `.dmg` or `~/Downloads` ⇒ read-only translocated path ⇒ `quitAndInstall` silently cannot replace the bundle. Permanent silent trap.
- **B2 — terminal dialog interception (fixed in v1.2.1, traps ≤ v1.2.0):** `before-quit` showed "a terminal is still running, quit anyway?" with `event.preventDefault()` and **Cancel as default** during the update quit. Guard added in `#310` (`d61650a`), shipped in v1.2.1.
- **B3 — fragile teardown:** install relies on Electron's natural exit (skipping `reallyExit`), the same path documented as SIGABRT-prone after node-pty teardown.
- **A1 — button visibility tied to right-sidebar geometry:** since `#298` the button lives only in the right activity bar; collapsed (width 0) when the user moved all views away. (Unmerged `fix/update-button-restart-and-visibility` fixes this; only its `Sidebar.tsx` half is novel — its `index.ts` half already landed via `#310`.)
- **A2 — no stalled-download recovery:** ~600 MB app; a stalled download leaves the button `disabled` on the progress ring forever (no timeout/retry).

---

## File Structure

- **Create** `src/main/updateInstaller.ts` — single owner of the install sequence + macOS eligibility + watchdog. Pure-testable helpers exported.
- **Create** `src/main/updateInstaller.test.ts` — unit tests for eligibility + watchdog + status reduction.
- **Modify** `src/main/auto-updater.ts` — delegate `UPDATE_INSTALL`/`UPDATE_DOWNLOAD` to the installer; add download-stall watchdog; emit `state:'manual'` (not `'error'`) when self-update is ineligible so the button stays actionable.
- **Modify** `src/main/index.ts` — `before-quit`/`will-quit` become no-ops while installing (installer owns teardown); add macOS startup move-to-/Applications nudge.
- **Modify** `src/renderer/sidebar/UpdateButton.tsx` — render a recoverable affordance for `error` (with `releaseUrl`) and keep `manual` always clickable; add a stalled→retry affordance.
- **Modify** `src/renderer/sidebar/Sidebar.tsx` — keep the right activity bar visible when an update is actionable (merge the unmerged fix; also treat `error`-with-url as actionable).
- **Modify** `src/renderer/stores/updateStore.ts` — extend `error` variant with optional `releaseUrl`/`version` so the renderer can offer manual download on error.
- **Modify** `src/shared/ipc-channels.ts` (if needed) — no new channels expected; reuse `UPDATE_OPEN_RELEASE`, `UPDATE_DOWNLOAD`, `UPDATE_INSTALL`.

> Type contract used throughout (keep names identical across tasks):
> - `isUpdateInstalling(): boolean`
> - `performUpdateInstall(): Promise<void>`
> - `canSelfUpdateMac(): boolean` (true ⇒ `quitAndInstall` is viable on macOS)
> - `UpdateStatus` gains `error` variant: `{ state: 'error'; message: string; version?: string; releaseUrl?: string }`

---

## Task 1: Extract a pure macOS self-update eligibility check

**Files:**
- Create: `src/main/updateInstaller.ts`
- Test: `src/main/updateInstaller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/updateInstaller.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const isInApplicationsFolder = vi.fn()
vi.mock('electron', () => ({
  app: {
    isInApplicationsFolder: () => isInApplicationsFolder(),
    getVersion: () => '1.2.1',
  },
}))

import { canSelfUpdate } from './updateInstaller'

describe('canSelfUpdate', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns true on non-darwin regardless of folder', () => {
    expect(canSelfUpdate('win32')).toBe(true)
    expect(canSelfUpdate('linux')).toBe(true)
  })

  it('returns true on darwin only when in /Applications (not translocated)', () => {
    isInApplicationsFolder.mockReturnValue(true)
    expect(canSelfUpdate('darwin')).toBe(true)
  })

  it('returns false on darwin when translocated / not in /Applications', () => {
    isInApplicationsFolder.mockReturnValue(false)
    expect(canSelfUpdate('darwin')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/updateInstaller.test.ts`
Expected: FAIL — `canSelfUpdate` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/updateInstaller.ts
import { app } from 'electron'

/** True when electron-updater's quitAndInstall can actually replace the running
 *  bundle. On macOS this is impossible when the app is running translocated
 *  (Gatekeeper App Translocation) or simply not in /Applications — both report
 *  app.isInApplicationsFolder() === false. Other platforms can always self-update. */
export function canSelfUpdate(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return true
  try {
    return app.isInApplicationsFolder()
  } catch {
    return true // if the API is unavailable, don't block the existing path
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/updateInstaller.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/updateInstaller.ts src/main/updateInstaller.test.ts
git commit -m "feat(update): pure macOS self-update eligibility check"
```

---

## Task 2: Install watchdog timer (surface failure instead of a dead button)

**Files:**
- Modify: `src/main/updateInstaller.ts`
- Test: `src/main/updateInstaller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/main/updateInstaller.test.ts
import { startInstallWatchdog } from './updateInstaller'

describe('startInstallWatchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onTimeout if not cancelled before the deadline', () => {
    const onTimeout = vi.fn()
    startInstallWatchdog(20000, onTimeout)
    vi.advanceTimersByTime(19999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('does not fire if cancelled', () => {
    const onTimeout = vi.fn()
    const cancel = startInstallWatchdog(20000, onTimeout)
    cancel()
    vi.advanceTimersByTime(60000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
```

(Add `afterEach` to the imports from `vitest`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/updateInstaller.test.ts`
Expected: FAIL — `startInstallWatchdog` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/main/updateInstaller.ts
/** Arms a timer that calls onTimeout if the process is still alive after `ms`.
 *  Used to detect "quitAndInstall fired but the app never quit/relaunched" so
 *  the UI can recover (offer manual download) instead of hanging on a dead
 *  Restart button. Returns a cancel fn (call it from a 'before-quit' that
 *  actually fires — i.e. the install really is proceeding). */
export function startInstallWatchdog(ms: number, onTimeout: () => void): () => void {
  const t = setTimeout(onTimeout, ms)
  return () => clearTimeout(t)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/updateInstaller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/updateInstaller.ts src/main/updateInstaller.test.ts
git commit -m "feat(update): install watchdog to detect failed quitAndInstall"
```

---

## Task 3: `performUpdateInstall` — single owner of the install-quit sequence

**Files:**
- Modify: `src/main/updateInstaller.ts`
- Test: `src/main/updateInstaller.test.ts`

**Design (the heart of the re-architecture):** `performUpdateInstall` does, in order: (1) guard re-entrancy; (2) macOS eligibility — if `!canSelfUpdate()`, broadcast `manual` (route to in-app nudge) and stop; (3) set `installing = true` so the generic quit handlers step aside; (4) flush session **once**; (5) deterministic teardown (caller-injected); (6) arm watchdog; (7) `quitAndInstall(false, true)`. Dependencies are injected so this is unit-testable without a packaged app.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/main/updateInstaller.test.ts
import { performUpdateInstall, isUpdateInstalling, __resetInstallerForTests } from './updateInstaller'

describe('performUpdateInstall', () => {
  beforeEach(() => { vi.useRealTimers(); __resetInstallerForTests() })

  const baseDeps = () => ({
    platform: 'darwin' as NodeJS.Platform,
    canSelfUpdate: () => true,
    flushSession: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
    quitAndInstall: vi.fn(),
    broadcast: vi.fn(),
    manualReleaseUrl: 'https://example/releases',
    version: '1.3.0',
  })

  it('runs flush → teardown → quitAndInstall when eligible', async () => {
    const d = baseDeps()
    await performUpdateInstall(d)
    expect(d.flushSession).toHaveBeenCalledOnce()
    expect(d.teardown).toHaveBeenCalledOnce()
    expect(d.quitAndInstall).toHaveBeenCalledOnce()
    expect(isUpdateInstalling()).toBe(true)
  })

  it('does NOT quitAndInstall when ineligible; broadcasts manual', async () => {
    const d = { ...baseDeps(), canSelfUpdate: () => false }
    await performUpdateInstall(d)
    expect(d.quitAndInstall).not.toHaveBeenCalled()
    expect(d.teardown).not.toHaveBeenCalled()
    expect(d.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'manual', releaseUrl: 'https://example/releases', version: '1.3.0' }),
    )
    expect(isUpdateInstalling()).toBe(false)
  })

  it('is idempotent (second call is a no-op while installing)', async () => {
    const d = baseDeps()
    await performUpdateInstall(d)
    await performUpdateInstall(d)
    expect(d.quitAndInstall).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/updateInstaller.test.ts`
Expected: FAIL — `performUpdateInstall` / `isUpdateInstalling` / `__resetInstallerForTests` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/main/updateInstaller.ts
type InstallerStatus =
  | { state: 'manual'; version: string; releaseUrl: string }
  | { state: 'error'; message: string; version?: string; releaseUrl?: string }
  | { state: 'downloaded'; version: string }

export interface InstallDeps {
  platform: NodeJS.Platform
  canSelfUpdate: () => boolean
  flushSession: () => Promise<void>
  teardown: () => void
  quitAndInstall: () => void
  broadcast: (s: InstallerStatus) => void
  manualReleaseUrl: string
  version: string
}

let installing = false
export function isUpdateInstalling(): boolean { return installing }
export function __resetInstallerForTests(): void { installing = false }

export async function performUpdateInstall(deps: InstallDeps): Promise<void> {
  if (installing) return
  // macOS: if we can't replace the bundle, never pretend to — route to manual.
  if (!deps.canSelfUpdate()) {
    deps.broadcast({ state: 'manual', version: deps.version, releaseUrl: deps.manualReleaseUrl })
    return
  }
  installing = true
  await deps.flushSession()
  deps.teardown()
  deps.quitAndInstall()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/updateInstaller.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add src/main/updateInstaller.ts src/main/updateInstaller.test.ts
git commit -m "feat(update): performUpdateInstall owns the install-quit sequence"
```

---

## Task 4: Wire `auto-updater.ts` install handler to the installer

**Files:**
- Modify: `src/main/auto-updater.ts` (the `UPDATE_INSTALL` handler, currently lines ~276-295; the `quitAndInstall`/`flushSessionBeforeUpdate`/`updateInstalling` bits, lines ~42-51, 84-104, 289-294)

**Note:** Replace the local `updateInstalling` flag + direct `quitAndInstall` with delegation to `updateInstaller`. Keep `isInstallingUpdate()` exported from `auto-updater.ts` (index.ts imports it) but have it return `isUpdateInstalling()` from the installer, so there is one source of truth.

- [ ] **Step 1: Implement delegation**

Replace the `updateInstalling` declaration/`isInstallingUpdate` (lines ~45-51) with:

```ts
import { isUpdateInstalling, performUpdateInstall, canSelfUpdate } from './updateInstaller'
import { deterministicQuitTeardown } from './index' // exported in Task 5

/** Single source of truth, read by src/main/index.ts quit handlers. */
export function isInstallingUpdate(): boolean { return isUpdateInstalling() }
```

Replace the `UPDATE_INSTALL` handler body (the packaged branch, lines ~285-294) with:

```ts
    if (!app.isPackaged) return
    log.info('[auto-updater] Renderer requested install')
    const version = currentStatus.state === 'downloaded' ? currentStatus.version : app.getVersion()
    void sendEvent('update_install_clicked', { version })
    await performUpdateInstall({
      platform: process.platform,
      canSelfUpdate: () => canSelfUpdate(),
      flushSession: flushSessionBeforeUpdate,
      teardown: deterministicQuitTeardown,
      quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
      broadcast: (s) => broadcastStatus(s as UpdateStatus),
      manualReleaseUrl: latestReleaseUrl || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      version,
    })
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: passes once Task 5 exports `deterministicQuitTeardown`. (If executing in order, do Task 5's export first or stub it.)

- [ ] **Step 3: Run existing updater unit tests**

Run: `npx vitest run src/main/updateInstaller.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/auto-updater.ts
git commit -m "refactor(update): delegate install to updateInstaller (single owner)"
```

---

## Task 5: Make generic quit handlers step aside during install + export teardown

**Files:**
- Modify: `src/main/index.ts` (`before-quit` ~1768-1864, `will-quit` ~1866-1909)

**Design:** Extract the teardown body of `will-quit` into an exported, idempotent `deterministicQuitTeardown()`. While an install is in progress, `before-quit` returns immediately (no flush, no dialog, no preventDefault) and `will-quit` returns immediately after ensuring teardown ran once — because the installer already flushed + tore down. This deletes the double-flush, the dialog-interception risk, and the `reallyExit` ambiguity for the install path.

- [ ] **Step 1: Extract idempotent teardown**

Add near the quit handlers:

```ts
let quitTeardownDone = false
/** All sync cleanup that must happen before the process exits: session/state
 *  flushes, lock release, PTY kill, companion disposal. Idempotent so it can be
 *  called by the update installer (before quitAndInstall) AND by will-quit. */
export function deterministicQuitTeardown(): void {
  if (quitTeardownDone) return
  quitTeardownDone = true
  saveProjectStateSync()
  flushSettingsPendingWritesSync()
  flushWorkspaceStateSync()
  flushUIStateSync()
  releaseAllProjectLocks()
  killAllTerminals()
  void companions.disposeAll()
}
```

- [ ] **Step 2: Short-circuit `before-quit` during install**

At the very top of the `before-quit` handler (before the `sessionFlushed` check), add:

```ts
  // An update install is in flight: the update installer already flushed the
  // session and ran deterministicQuitTeardown(). Do NOT flush again, do NOT
  // show the running-terminal dialog, do NOT preventDefault — just let the quit
  // proceed so electron-updater can relaunch the new version.
  if (isInstallingUpdate()) {
    log.info('before-quit: update install in progress — yielding to installer')
    return
  }
```

Then delete the now-redundant `if (!quitConfirmed && isInstallingUpdate()) { quitConfirmed = true }` block (it's superseded).

- [ ] **Step 3: Simplify `will-quit` for the install path**

Replace the install branch in `will-quit` (lines ~1892-1901) with:

```ts
  if (isInstallingUpdate()) {
    // Installer already tore down; ensure it ran, then let Electron's natural
    // exit proceed so electron-updater's relaunch hook fires. No reallyExit.
    deterministicQuitTeardown()
    log.info('will-quit: install in progress, yielding to Electron relaunch')
    return
  }
```

Leave the non-install path (the `reallyExit(0)`) unchanged for normal quits, but route its cleanup through `deterministicQuitTeardown()` to avoid duplicated logic:

```ts
  deterministicQuitTeardown()
  ;(process as unknown as { reallyExit(code: number): never }).reallyExit(0)
```

(Delete the now-inlined duplicate cleanup calls above that branch.)

- [ ] **Step 4: Typecheck + build main**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "refactor(quit): installer owns teardown; quit handlers yield during install"
```

---

## Task 6: macOS startup move-to-/Applications nudge (prevents future translocation traps)

**Files:**
- Modify: `src/main/index.ts` (app `ready`/`whenReady` path — find where the main window is created / `initAutoUpdater()` is called)

**Design:** On macOS packaged launch, if `!app.isInApplicationsFolder()`, show a one-time-per-launch dialog offering to move into /Applications (`app.moveToApplicationsFolder()` handles the move + relaunch). Gate with a setting so a user who declines isn't nagged every launch, but re-offer when an update is actually available (handled by the manual nudge in Task 7). This is the root fix for B1.

- [ ] **Step 1: Implement the nudge**

```ts
// in the macOS-only, app.isPackaged branch after whenReady():
if (process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder()) {
  const declined = getSettingSync('moveToApplicationsDeclined') === true
  if (!declined) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Move to Applications', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Move Cate to your Applications folder?',
      detail:
        'Cate is running from outside /Applications. macOS prevents apps in this location from updating themselves, so automatic updates will not work until Cate is moved. Your settings and sessions are preserved.',
    })
    if (choice === 0) {
      try { app.moveToApplicationsFolder() } // moves + relaunches
      catch (e) { log.error('[update] moveToApplicationsFolder failed', e) }
    } else {
      void setSetting('moveToApplicationsDeclined', true)
    }
  }
}
```

(Use the existing settings helpers — confirm names: `getSettingSync`, and the setter used elsewhere in index.ts. Add `moveToApplicationsDeclined` to the settings schema/defaults next to other booleans.)

- [ ] **Step 2: Add the setting default**

Add `moveToApplicationsDeclined: false` to the settings defaults/schema (find where `betaUpdatesEnabled` is defined in `src/main/store.ts` and mirror it).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/store.ts
git commit -m "feat(update): macOS startup nudge to move Cate into /Applications"
```

---

## Task 7: Download-stall watchdog + ineligible-download routing in `auto-updater.ts`

**Files:**
- Modify: `src/main/auto-updater.ts` (`UPDATE_DOWNLOAD` handler ~231-274; `download-progress` handler ~368-382)

**Design:** (a) Before starting a native download on macOS, if `!canSelfUpdate()`, skip the download and broadcast `manual` (downloading a 600 MB zip that can never install is pure waste + a trap). (b) Arm a stall watchdog: if no `download-progress` for 90 s while in `downloading`, broadcast `error` **with `releaseUrl`+`version`** so the button offers manual download/retry. Reset the watchdog on each progress event and on `update-downloaded`.

- [ ] **Step 1: Guard the download for ineligible macOS**

At the top of the packaged `UPDATE_DOWNLOAD` branch (after `if (!app.isPackaged) return`):

```ts
    if (!canSelfUpdate()) {
      const v = currentStatus.state === 'available' ? currentStatus.version : app.getVersion()
      const url = (currentStatus.state === 'available' ? currentStatus.releaseUrl : null) || latestReleaseUrl
        || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
      log.info('[auto-updater] self-update ineligible (translocated/not in /Applications) — routing to manual')
      broadcastStatus({ state: 'manual', version: v, releaseUrl: url })
      return
    }
```

- [ ] **Step 2: Add the stall watchdog**

```ts
let downloadStallTimer: ReturnType<typeof setTimeout> | null = null
const DOWNLOAD_STALL_MS = 90_000
function armDownloadStall(version: string): void {
  if (downloadStallTimer) clearTimeout(downloadStallTimer)
  downloadStallTimer = setTimeout(() => {
    if (currentStatus.state !== 'downloading') return
    const url = latestReleaseUrl || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    log.warn('[auto-updater] download stalled — surfacing manual fallback')
    broadcastStatus({ state: 'error', message: 'Download stalled. Click to download manually.', version, releaseUrl: url })
  }, DOWNLOAD_STALL_MS)
}
function clearDownloadStall(): void {
  if (downloadStallTimer) { clearTimeout(downloadStallTimer); downloadStallTimer = null }
}
```

Call `armDownloadStall(version)` right after broadcasting `downloading` in the download handler; call `armDownloadStall(version)` again inside `download-progress` (resets it); call `clearDownloadStall()` in `update-downloaded` and on `error`.

- [ ] **Step 2b: Stop swallowing download errors (the "stuck forever" bug)**

The `autoUpdater.on('error', ...)` handler currently does `if (currentStatus.state === 'downloading') return` — a download that errors mid-way is swallowed and the button hangs on the spinner with no feedback. Replace that early-return so a download error degrades to a recoverable manual affordance:

```ts
  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err)
    clearDownloadStall()
    if (currentStatus.state === 'downloading') {
      // Don't strand the user on a dead spinner — offer manual download.
      const version = currentStatus.version
      const url = latestReleaseUrl || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
      broadcastStatus({ state: 'error', message: 'Update download failed. Click to download manually.', version, releaseUrl: url })
      return
    }
    const wasManual = isManualCheck
    isManualCheck = false
    fallbackCheckForUpdate(wasManual)
  })
```

**Funnel invariant (enforced across Tasks 7–10):** every non-`idle` state shows a visible affordance, and every failure path (`error` during check, `error` during download, stall, macOS ineligible) resolves to either a working native action OR a manual-download option — never a vanished button, never a frozen spinner.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (requires `error` variant carrying `version`/`releaseUrl` — Task 8 updates the shared type; do Task 8 first or update both together).

- [ ] **Step 4: Commit**

```bash
git add src/main/auto-updater.ts
git commit -m "feat(update): skip doomed mac downloads; recover from stalled downloads"
```

---

## Task 8: Extend `error` status with recovery info (main + renderer types)

**Files:**
- Modify: `src/main/auto-updater.ts` (`UpdateStatus` type ~57-64)
- Modify: `src/renderer/stores/updateStore.ts` (`UpdateStatus` ~9-16)
- Modify: `src/shared/types.ts` / `src/shared/electron-api.d.ts` if `UpdateStatus` is declared there too (grep first)

- [ ] **Step 1: Update the union in all declarations**

Change the `error` member everywhere from:

```ts
| { state: 'error'; message: string }
```

to:

```ts
| { state: 'error'; message: string; version?: string; releaseUrl?: string }
```

Run first: `grep -rn "state: 'error'; message: string }" src` and update each hit.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/auto-updater.ts src/renderer/stores/updateStore.ts src/shared
git commit -m "feat(update): carry version/releaseUrl on error status for recovery"
```

---

## Task 9: Button always exposes a recovery affordance (renderer)

**Files:**
- Modify: `src/renderer/sidebar/UpdateButton.tsx`

**Design:** Today `error` renders `null` (button vanishes, hiding the trap). Make `error` render when it has a `releaseUrl` — a manual-download glyph that opens the release page. This is the in-app rescue affordance.

- [ ] **Step 1: Render on recoverable error**

Change the early-return guard (lines ~25-32) to also keep rendering for `error` with a `releaseUrl`:

```tsx
  const isRecoverableError = status.state === 'error' && !!status.releaseUrl
  if (
    status.state !== 'available' &&
    status.state !== 'downloading' &&
    status.state !== 'downloaded' &&
    status.state !== 'manual' &&
    !isRecoverableError
  ) {
    return null
  }
```

Add an `error` case to `baseTitle` (`'Update download failed. Click to download manually.'`), to the glyph (`ArrowSquareOut`, like `manual`), and to `onAction`:

```tsx
    } else if (status.state === 'error' && status.releaseUrl) {
      window.electronAPI.updateOpenRelease(status.releaseUrl)
    }
```

Ensure `disabled` is only true for `downloading` (unchanged).

- [ ] **Step 2: Build renderer / typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Manual dev check (simulation)**

Run: `CATE_SIMULATE_UPDATE_BUTTON=manual npm run dev` (see `dev:update:button` script). Verify the button shows and clicking opens the release page. (No automated test — renderer is visually verified; logic covered by main-side tests.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/sidebar/UpdateButton.tsx
git commit -m "feat(update): keep update button actionable on error (manual download)"
```

---

## Task 10: Keep the right activity bar visible when an update is actionable

**Files:**
- Modify: `src/renderer/sidebar/Sidebar.tsx`

**Design:** Port the unmerged `fix/update-button-restart-and-visibility` Sidebar change, extended to treat recoverable `error` as actionable so the rescue affordance is never hidden by a collapsed sidebar.

- [ ] **Step 1: Add actionable-update detection + width override**

After `const isEmpty = views.length === 0`:

```tsx
  const updateStatus = useUpdateStore((s) => s.status)
  const hasActionableUpdate =
    side === 'right' &&
    (updateStatus.state === 'available' ||
      updateStatus.state === 'downloading' ||
      updateStatus.state === 'downloaded' ||
      updateStatus.state === 'manual' ||
      (updateStatus.state === 'error' && !!updateStatus.releaseUrl))
```

In the `width` style, replace the `isEmpty && !dragRevealed ? 0` branch with:

```tsx
        width:
          isEmpty && !dragRevealed
            ? hasActionableUpdate
              ? BAR_WIDTH
              : 0
            : isExpanded
              ? BAR_WIDTH + width
              : BAR_WIDTH,
```

Add the import: `import { useUpdateStore } from '../stores/updateStore'`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Manual dev check**

Run: `CATE_SIMULATE_UPDATE_BUTTON=available npm run dev`, move all views to the left sidebar, confirm the right bar stays open showing the button.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/sidebar/Sidebar.tsx
git commit -m "fix(update): keep update button visible when right sidebar empty"
```

---

## Task 11: Full unit suite + lint + typecheck gate

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: PASS (including new `updateInstaller.test.ts`).

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "chore(update): lint/typecheck fixups"
```

---

## Task 12: Manual verification on a real packaged build (the parts unit tests cannot cover)

> Auto-update relaunch, Squirrel.Mac, and translocation are OS-level — they MUST be verified on a real signed build updating to a higher real version. Use `superpowers:verification-before-completion` before claiming done.

- [ ] **macOS, in /Applications (happy path):** install current release in /Applications, publish a test release with a higher version, confirm the button appears → download → Restart → app relaunches on the new version with sessions intact.
- [ ] **macOS, translocated (the trap):** run the app from the mounted `.dmg` (do NOT drag to Applications). Confirm: startup nudge offers move-to-/Applications; if declined, clicking the update button routes to `manual` (opens release page) instead of a dead Restart.
- [ ] **macOS, downloaded-then-Restart with a terminal running:** start a long-running process in a terminal, click Restart, confirm NO "terminal still running" dialog interrupts and the app relaunches.
- [ ] **Windows:** confirm download → Restart → relaunch on the new version (NSIS).
- [ ] **Stall recovery:** throttle network mid-download (or set `DOWNLOAD_STALL_MS` low in a test build); confirm the button transitions to the manual-download affordance instead of hanging.

---

## Self-Review (completed against the spec)

- **Re-architect install path** → Tasks 3–5 (single owner, quit handlers yield, deterministic teardown). ✓
- **macOS-first / translocation** → Tasks 1, 6, 7 (eligibility, startup nudge, doomed-download guard). ✓
- **In-app nudge rescue** → Tasks 7–10 (manual routing on ineligible/stall/error; button + sidebar always expose it). ✓
- **Stalled download** → Task 7. ✓
- **Button visibility** → Task 10. ✓
- **Analytics funnel** → pre-req section (human-owned). ✓
- **Type consistency:** `isUpdateInstalling`/`isInstallingUpdate`, `canSelfUpdate`, `performUpdateInstall`, `deterministicQuitTeardown`, `error` variant with `version?`/`releaseUrl?` used consistently across Tasks 1–10. ✓
- **Cannot fully TDD OS-level relaunch** — covered by Task 12 manual verification, explicitly flagged. ✓
