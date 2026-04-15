# Cate Hardening And Stability Plan, Rev 3

## Summary
- Land this work as five PRs, in order: `branch fix + test harness`, `trust model + workspace sync`, `webview/window hardening`, `renderer sandbox + entitlement reduction`, `updater verification`.
- Each PR starts with a non-mutating compatibility pass, then lands the change behind a dev-only fallback flag. Production builds must ignore any flag that disables a security control.
- Flag removal is scheduled up front:
  - PR 2 flag removed in `N+1`
  - PR 3 flag removed in `N+1`
  - PR 4 flag removed in `N+2`
  - PR 5 flag removed when verified updater ships as default, no later than `N+2`

## Public API And Behavior Changes
- `workspace:create` and `workspace:update` become authoritative: invalid `rootPath` rejects the IPC and returns a typed error payload; renderer must not treat rejected roots as usable.
- `git:branchCreate(cwd, branchName, startPoint?)` keeps its signature and must honor `startPoint`.
- Security fallback flags are dev-only:
  - ignored when `app.isPackaged === true`
  - not documented for end users
  - guarded in a single main-process feature-flag module
- One-shot file-write allowance is introduced for save/export flows:
  - exact path only
  - single use
  - TTL `60s`
  - scoped to the requesting window
  - cleared on consume, timeout, cancel, and window close

## PR 1: Branch Fix And Test Harness
- Fix `GIT_BRANCH_CREATE` to branch from `startPoint` when present, otherwise from current `HEAD`.
- Add a two-layer test stack:
  - `vitest` for pure or unit-tested modules with mocked `electron` imports
  - Electron smoke tests for real `app` and `BrowserWindow` behavior on macOS CI
- CI matrix:
  - all OSes: build, typecheck, vitest
  - macOS only: Electron smoke tests
- Add tests for branch creation from `HEAD`, tag, SHA, and remote ref.

## PR 2: Trust Model And Workspace Sync
- Remove startup `addAllowedRoot(app.getPath('home'))`.
- Change workspace root validation to accept any existing directory via `realpath + stat`, not a `~/` policy.
- Main process owns trust lifecycle:
  - `addAllowedRoot` on accepted workspace create or update
  - `removeAllowedRoot` on workspace root replacement and workspace removal
- During session load, extract valid workspace roots from persisted workspaces and detached window workspace references, register them before returning the payload to renderers.
- Renderer sync policy:
  - renderer may create a visual pending workspace shell immediately
  - renderer must not allow panel or terminal creation inside that workspace until main ack succeeds
  - rejected roots stay visible as inline error state and are removable by the user
- One-shot save/export allowance:
  - `DIALOG_SAVE_FILE` registers an exact-path write token for the requesting window
  - token expires after `60s`
  - token is consumed only by the next matching `FS_WRITE_FILE`
  - token is cleared on dialog cancel, timeout, successful consume, and owning window close
- Drop-path model:
  - workspace-root drops go through `workspace:update` only
  - terminal drops remain unprivileged text insertion only
  - file-explorer internal moves continue through `fsRename`
  - no external OS drop path receives blanket trust

## PR 3: Webview And Window Hardening
- Verify Electron 41 guest-hardening APIs against the pinned version before landing.
- Add `app.on('web-contents-created')` main-process policy for app windows:
  - deny `window.open` by default
  - block app-window navigation away from the local app origin
- Harden guest webviews:
  - use `will-attach-webview` on the owning contents
  - strip guest preload
  - force `nodeIntegration=false`
  - force `contextIsolation=true`
  - force `sandbox=true`
  - force `webSecurity=true`
  - force `allowpopups=false`
- Add per-session guest controls for partitioned webviews:
  - `session.setPermissionRequestHandler` deny-by-default
  - `session.setPermissionCheckHandler` deny-by-default where applicable
  - guest-session `webRequest` rules to enforce scheme policy and block unsafe top-level navigations
- Initial guest URL allow-list:
  - `http:`
  - `https:`
  - `about:blank`
- Before removing the dev-only fallback, explicitly verify whether browser panels need `file:` or `data:`. If needed, allow only the specific scheme with a documented reason.
- `webviewScreenshot` works via main-process `webContents.capturePage`; screenshots are not a reason to add guest preload.

## PR 4: Renderer Sandbox And macOS Entitlements
- Complete a full preload audit before enabling the renderer sandbox by default.
- Enable `sandbox: true` on the main `BrowserWindow`, behind a dev-only fallback until verified.
- Smoke-test under sandbox:
  - startup
  - settings load
  - session restore
  - terminal creation
  - browser panel
  - file explorer
  - command palette
- macOS entitlements:
  - keep `allow-jit`
  - keep `disable-executable-page-protection` unless packaged runtime testing proves safe removal
  - test these removal candidates in packaged builds before dropping them:
    - `allow-dyld-environment-variables`
    - `disable-library-validation`
    - `device.camera`
    - `device.audio-input`
    - `network.server`
  - `network.server` specifically requires packaged-build verification with local preview and dev-server workflows
- Record the final entitlement rationale in packaging docs.

## PR 5: Updater Verification
- Do not ship unverified local install.
- Split fallback updater into:
  - release and version discovery
  - verified asset installation
- Until verification is implemented, fallback behavior is:
  - detect newer release
  - offer release-page or manual download flow
  - no mount, spawn, or overwrite of downloaded assets
- Verified install requirements before enabling default:
  - authenticated metadata for asset integrity
  - verification before mount, spawn, or replace
  - replace current install only after verification succeeds
  - distinct UX for check failure, verification failure, and manual-install fallback

## Test Plan
- `vitest` unit tests:
  - path validation and trust revocation
  - one-shot write token lifecycle
  - session-load trust hydration
  - workspace rejection and pending-state reconciliation
  - branch creation semantics
- Electron smoke tests on macOS CI:
  - app boots with sandboxed renderer
  - restored workspace can access files immediately after launch
  - pending workspace cannot create panels before ack
  - browser panel cannot open popups or escape app navigation rules
  - guest permission requests are denied
- Cross-platform CI:
  - Windows and Linux run build, typecheck, and unit tests only
- Manual packaged-build checks before PR 4 and PR 5 merge:
  - macOS packaged launch under reduced entitlements
  - local preview and dev-server workflows with `network.server` candidate removal
  - updater fallback never installs unverified assets

## Assumptions And Defaults
- Browser panels are untrusted by default.
- Guest preload is unnecessary unless a concrete audited requirement appears.
- Production builds must not honor security-disabling flags.
- Pending workspace UX is preferred over optimistic full creation plus rollback, to avoid orphaned panels and terminals.
- PR descriptions will include the exact flag-removal target release before merge.
