# Update Reliability — Stock electron-updater, Zero Custom UI

**Decision (2026-06-07):** after auditing ~10 prior point-fixes that never held, we removed the entire custom update UI/IPC/install machinery and switched to electron-updater's defaults, keeping only the two things the defaults genuinely don't handle. The custom path was the source of the recurring breakage; deleting it removes the whole class of bugs.

## What shipped (branch `fix/update-funnel-reliability`)

**Mechanism — electron-updater defaults (`src/main/auto-updater.ts`):**
- `autoDownload = true` — updates download in the background.
- `autoInstallOnAppQuit = true` — the downloaded update installs on the next normal quit; the user reopens on the new version. No button, no forced mid-session restart.
- `checkForUpdatesAndNotify()` on launch (+5s) and every 15 min — native OS notification when an update is ready.
- Beta channel preserved (`allowPrerelease` from the `betaUpdatesEnabled` setting + live `setBetaUpdatesEnabled`).
- "Check for Updates…" menu items kept (standard), wired to a manual check.

**Fix 1 — macOS App Translocation (`src/main/updateInstaller.ts` + auto-updater):**
- `canSelfUpdate()` = `false` on macOS when `!app.isInApplicationsFolder()` (translocated or outside /Applications) — where `quitAndInstall`/install-on-quit silently cannot replace the bundle.
- When ineligible: `autoDownload`/`autoInstallOnAppQuit` are disabled (never download a ~600 MB asset that can't apply); instead, when a check finds an update, prompt the user to **Move to Applications** (`app.moveToApplicationsFolder()`, which relaunches into /Applications). This is the only way already-trapped mac users get unstuck. Prompt-once-per-launch; re-armed on explicit "Check for Updates…".

**Fix 2 — quit path no longer kills the on-quit installer (`src/main/index.ts`):**
- `will-quit` previously always called `process.reallyExit(0)` (libc exit) to dodge a node-pty SIGABRT. That bypasses electron-updater's install-on-quit hook (it runs on the `quit` event, which fires *after* `will-quit`), so the update would never apply. Now: when `isUpdatePendingInstall()` is true, `will-quit` returns without `reallyExit`, letting the natural quit proceed so the install runs.
- Removed the obsolete `before-quit` "update install in flight" special-case — updates now install on a *normal* quit, so the normal terminal-confirmation behavior is correct.

**Deleted (custom UI/IPC surface):**
- `src/renderer/sidebar/UpdateButton.tsx`, `src/renderer/stores/updateStore.ts`
- update IPC channels (`UPDATE_STATUS/INSTALL/DOWNLOAD/OPEN_RELEASE`), preload methods, `electron-api.d.ts` decls
- App.tsx update-status effect, Sidebar.tsx button + visibility logic
- the GitHub-API fallback path, the in-app sim, manual download/install handlers

## Verification status

- ✅ `tsc --noEmit` clean; `eslint` 0 new errors/warnings; full unit suite **1032 pass / 3 skip**; `electron-vite build` succeeds.
- ⚠️ **OS-level behavior NOT yet verified on a real build** — must be done before release (see below). Unit tests cover `canSelfUpdate`; the install/relaunch/translocation paths are inherently integration-level.

## Required manual verification (real signed build → higher real release)
- [ ] **macOS in /Applications:** older build installed in /Applications; publish a higher release; confirm it downloads silently, native notification appears, and quitting → reopening lands on the new version.
- [ ] **macOS translocated (the trap):** run from the mounted `.dmg`/`~/Downloads`; confirm that when an update exists, the Move-to-Applications prompt appears, and accepting relaunches from /Applications and then updates normally.
- [ ] **Quit with a terminal running + update staged:** confirm normal terminal-confirm dialog, and after confirming quit the update installs (no `reallyExit` bypass).
- [ ] **Windows / Linux:** confirm background download + install-on-quit still works.

## Rescue for already-trapped users
- macOS: the Move-to-Applications prompt is the in-app escape (once they're on any build that has this code). For users on *old* broken builds that predate this, the data-safe path remains: download the latest `.dmg`/`.exe` and reinstall over the top (user data lives in `~/Library/Application Support/Cate`, untouched). Server-side release metadata is already correct, so a reinstall always works.
