# Native Apps on Canvas (macOS) — Design

**Status:** Draft for review
**Date:** 2026-07-14
**Branch:** `worktree-native-window-support`
**Tracking issue:** [#122](https://github.com/0-AI-UG/cate/issues/122)
**Platform scope:** macOS only (biggest user group). Windows/Linux explicitly out of scope for this spec.

---

## 1. Goal

Let a user place a **real, arbitrary native macOS application** (a browser with its own extensions/devtools, a terminal like WezTerm, Cursor, Slack, etc.) onto the Cate canvas as a panel that behaves like every other panel: it **scales with canvas zoom**, is **resizable**, **clips** to the viewport, is **occluded** correctly by other panels, and is **interactive** (mouse + keyboard). The app must appear to *live only on the canvas* — not as a stray window on the user's real desktop.

This is the feature the issue thread has been circling: "an endless canvas for all apps," not just Cate's built-in panels.

## 2. Approach in one sentence

Because macOS does not permit embedding another process's window into ours (cross-process view reparenting doesn't exist; foreign-window overlay can't zoom/clip/occlude), we do **not** borrow the window. Instead we **capture** the app as a live GPU texture and **composite** it into a canvas panel, **forwarding input** back to the real window — a purpose-built, in-canvas remote-desktop of a single app, rendered onto a **headless virtual display** so it never appears on the user's real screens.

## 3. Non-goals

- **Not** true window reparenting (`NSWindow addChildWindow` across processes — impossible; the private window-server ordering APIs can't scale/clip/occlude). Rejected during brainstorming.
- **Not** a browser-panel upgrade. The Okta/LastPass/devtools pain several thread users raised is better solved by improving Cate's Chromium `<webview>` `BrowserPanel` (extensions, devtools, persistent auth). That is a **separate, cheaper project** and is out of scope here.
- **Not** cross-platform. Windows (`SetParent`) and Linux/Wayland are future work with entirely different mechanisms.
- **Not** Mac App Store distribution. This design uses private APIs (see §10) incompatible with MAS. Cate ships via notarized GitHub Releases, which is fine.
- **Not** removing the captured app's **Dock icon** — see §8, accepted limitation.

## 4. Hard macOS constraints that shape the design

These are physics, not choices:

1. **No cross-process view embedding.** You cannot pull another app's `NSView`/`NSWindow` into Cate's process. Capture is the only way to get its pixels.
2. **Capture requires rendering.** ScreenCaptureKit (SCK) can only capture a window WindowServer is actually compositing. You **cannot** capture a minimized or `NSApp hide`-hidden window — its backing store stops updating and the capture freezes. There is **no** way to render an arbitrary third-party GUI app to a buffer with no display context at all (that only exists for content we host ourselves, e.g. Chromium offscreen rendering).
3. **Off-screen/occluded windows can be render-throttled** (App Nap / occlusion state), which freezes capture. Rendering onto an **active virtual display** avoids this because the window is genuinely "on a display."
4. **The Dock is per-session, display-independent.** An app on a virtual display still shows its Dock icon. Suppressing another app's Dock presence needs fragile private tricks; we don't.

## 5. Architecture

### 5.1 Components

```
┌──────────────────────────────────────────────────────────────┐
│ Cate (Electron)                                               │
│                                                              │
│  Renderer                          Main process               │
│  ┌────────────────────────┐        ┌───────────────────────┐  │
│  │ NativeAppPanel (React) │        │ NativeAppBroker       │  │
│  │  - draws IOSurface tex │◄─IPC──►│  - lifecycle/PID mgmt │  │
│  │  - maps input→helper   │        │  - permission gating  │  │
│  │  - resize→helper       │        │  - spawns 1 helper    │  │
│  └────────────────────────┘        │    per captured app   │  │
│           ▲ texture handle          └──────────┬────────────┘  │
└───────────┼───────────────────────────────────┼───────────────┘
            │ IOSurface (shared GPU)             │ stdio/socket
            │                                    ▼
     ┌──────┴───────────────────────────────────────────────┐
     │ cate-nativehost (Swift helper, one per captured app)  │
     │  - creates/uses headless CGVirtualDisplay             │
     │  - launches or attaches target app onto that display  │
     │  - SCStream capture → IOSurface frames                │
     │  - CGEvent injection (mouse/keyboard)                  │
     │  - resizes target window to match panel logical size  │
     │  - captures child windows (menus/dialogs) too         │
     └──────────────────────────────────────────────────────┘
                          │ manages
                          ▼
              ┌───────────────────────┐
              │ Target native app     │  (renders on virtual
              │  (Chrome / WezTerm…)  │   display, never on a
              └───────────────────────┘   real screen)
```

### 5.2 Why an isolated Swift helper process (not an in-process addon)

Decided during brainstorming (option "B"). Rationale:

- **Crash isolation.** A wedged capture or a hung `CGEvent` call kills the helper, not Cate. The panel shows a "reconnect" state; the app stays alive.
- **No custom-addon ABI churn.** Cate today builds **no native addon of its own** — native code comes only from deps (`node-pty`, `koffi`) via `@electron/rebuild`. A standalone signed Swift executable avoids adding a custom `.node` to the rebuild/ABI treadmill. It mirrors the isolation model Cate already trusts for terminals (node-pty backend).
- **Permission containment.** Screen-Recording and Accessibility prompts attach to the helper's usage, kept out of the main app's crash-and-signing domain as much as macOS allows (see §8 caveat).
- **`koffi`-only was ruled out.** SCK is an async, delegate-driven ObjC/Swift framework — awkward-to-unworkable through raw FFI. `CGEvent` injection is FFI-able but capture isn't. Not viable as the primary path.

One helper **per captured app** (not one shared broker) for fault isolation and simpler per-app virtual-display/window ownership. The main-process `NativeAppBroker` supervises them.

### 5.3 Frame transport: IOSurface → GPU texture

- The helper renders SCK output into **`IOSurface`**-backed frames (`CVPixelBuffer`). `IOSurface` is shareable across processes by handle.
- The helper passes the surface handle to main → renderer over IPC; the renderer imports it as a **WebGL/WebGPU texture** and draws it in the `NativeAppPanel`'s `CanvasNode`.
- This is the performant path — **zero per-frame CPU copy** in the common case. Fallback (if surface sharing to the renderer proves impractical under Electron's sandbox): a shared-memory framebuffer with a single copy per frame. The transport is an **internal implementation detail behind a stable "give me the current frame texture" interface**, so we can start with the fallback and upgrade without touching the panel.

> **Spike dependency:** confirm an `IOSurface` produced in the helper can be imported as a GL/GPU texture in Cate's sandboxed renderer. If not, the shared-memory fallback is the MVP transport. (See §9.)

### 5.4 New panel type

Add `nativeApp` to the `PanelType` union (`src/shared/types.ts`) and register it following Cate's existing two-entry pattern:
- `src/shared/panels.ts` — `SharedPanelDefinition` (label, brand color, sizes, ghost SVG). Set **`canLiveOnCanvas: true`** and **`keepMountedOffscreen: true`** (the panel's live state is external, like `<webview>` extension panels — culling it would drop the capture session).
- `src/renderer/panels/registry.ts` — icon + lazy `NativeAppPanel` component + factory.

Everything else (drag/resize via `CanvasNode`, docking via `DockTabStack`, rendering through `PanelHost`, session persistence) comes for free from the existing panel machinery.

### 5.5 IPC surface (new channels in `src/shared/ipc-channels.ts`)

- `nativeApp:list-launchable` / `nativeApp:list-windows` — acquisition pickers (§6).
- `nativeApp:acquire` `{ mode: 'launch'|'attach', target }` → returns `{ sessionId }`.
- `nativeApp:frame` (main→renderer) — surface handle / framebuffer ready notifications.
- `nativeApp:input` (renderer→main→helper) — mouse/keyboard events in panel-local coords.
- `nativeApp:resize` — panel logical size → target window resize.
- `nativeApp:release` — teardown (quit or detach the app; destroy the helper + virtual display).
- `nativeApp:status` — permission state, helper health, child-window set.

## 6. Acquisition modes

Both modes are in scope (per brainstorming: "1 or 2" — both wanted). MVP builds **launch** first because it is meaningfully cleaner and de-risks the capture pipeline; **attach** follows once the pipeline is proven.

- **Launch (MVP-first).** User picks an executable (or from a small curated list). Cate spawns it, owns its PID/lifecycle, and — critically — moves it onto the headless virtual display **before it ever appears on a real screen**, so the transition is seamless. Restorable across sessions (we know how to relaunch). Cleanest possible UX.
- **Attach (follow-up).** User picks from currently-running windows via the system window picker (`SCContentSharingPicker`, macOS 14+). Works with already-open apps, no launch plumbing. Trade-offs made explicit to the user: Cate doesn't own lifecycle (panel goes to a dead/reconnect state if the app quits), harder to restore across sessions, and pulling an on-screen window onto the virtual display will visibly remove it from the user's normal desktop.

## 7. Rendering & interaction requirements

First-class requirements (not "nice to have"), because they are what make it feel real rather than a demo:

1. **Zoom / clip / occlude — free.** The frame is a texture in a normal `CanvasNode`, so canvas zoom scales it, the viewport clips it, and other panels occlude it, exactly like an editor or browser panel. No special work — this is the whole payoff of the capture approach.
2. **Panel resize → real window resize.** Resizing the panel must resize the **underlying app window** to the panel's logical size (accounting for retina backing scale) and re-capture at that resolution, so content **re-lays-out crisply** instead of bitmap-stretching. Panel-only texture scaling is the instantaneous feedback; the true resize settles behind it.
3. **Capture resolution & crispness.** Capture at native (or higher) resolution; drawing scaled keeps zoom-in sharp up to capture res. Optionally raise source capture resolution on deep zoom.
4. **Input mapping.** Canvas-space pointer → panel-local → real-window coords, forwarded via `CGEvent`. Must handle: click/drag/scroll, keyboard focus + modifiers, IME/text input. This is real, detail-heavy work.
5. **Child-window capture (the fiddliest part).** Menus, tooltips, autocomplete popups, `<select>` dropdowns, and modal dialogs spawn as **separate OS windows**. The helper must detect windows belonging to the target app/PID and composite them into the same panel at the correct relative position — otherwise a right-click menu appears off-canvas. **This is the single feature that separates "demo" from "real"** and must be scoped as core, not deferred.

## 8. Cleanliness, permissions, entitlements

- **Headless virtual display (MVP baseline).** Create a `CGVirtualDisplay` attached to no physical monitor; render the target app there. It is genuinely **not on the user's desktop** (not merely moved off-screen), and being on an *active* display **eliminates the occlusion-throttling freeze risk**. This is a private API but is widely used by shipping notarized apps (BetterDisplay, Deskreen, Sidecar-class tools).
- **Dock icon: accepted limitation.** The captured app **will show in the Dock** for MVP. Not reliably suppressible for arbitrary third-party apps without fragile private tricks. Documented, accepted.
- **Permissions required from the user:** Screen Recording (SCK) and Accessibility (`CGEvent` posting). First-run flow must detect, explain, and deep-link to System Settings, and degrade gracefully (view-only if Accessibility is denied).
- **Entitlements / Info.plist.** Update `build/entitlements.mac.plist` (+ runtime/dev variants) and usage-description strings. Confirm hardened-runtime + notarization still pass with the helper binary and the added capabilities. **Caveat to verify:** whether the capture/accessibility permission prompts attribute to the helper or to Cate.app depends on bundle/signing structure — must be checked during the spike, as it affects the permission UX story.

## 9. Risks & spike-first plan

**Step zero is a time-boxed (~1–2 day) spike, before committing to the full build.** It must prove, on real target apps (a browser, WezTerm, Cursor, Slack):

1. **Off-screen/virtual-display liveness** — app rendered on a headless `CGVirtualDisplay` keeps producing live SCK frames (no App-Nap freeze) across all four apps. *(Highest risk. If this fails for common apps, the feature premise is in question.)*
2. **IOSurface → renderer texture** — a helper-produced `IOSurface` imports as a GL/GPU texture in Cate's sandboxed renderer. If not, adopt the shared-memory-copy fallback as MVP transport.
3. **Input round-trip** — a forwarded `CGEvent` click/keystroke lands correctly in the virtual-display window.
4. **Child-window detection** — a right-click menu is detectable as a separate window owned by the target PID and locatable relative to the main window.
5. **Permission attribution** — confirm which bundle the Screen-Recording/Accessibility prompts attach to.

Ordered risk after the spike: child-window compositing fidelity > input fidelity (IME, modifiers, drag) > per-app quirks (some apps resist resize or off-screen rendering) > frame-transport performance under many panels.

## 10. MVP scope vs. later

**MVP (this project):**
- `launch` acquisition, headless virtual display, single main window capture + child-window capture, IOSurface-or-fallback transport, full mouse+keyboard input, panel-resize→window-resize, session-restorable, first-run permission flow. Dock icon shown (accepted).

**Follow-ups (separate specs):**
- `attach` to existing windows (`SCContentSharingPicker`).
- Virtual-display polish / per-app resolution tuning.
- Windows / Linux platform paths.
- Curated app catalog & per-app tuning profiles.

## 11. Success criteria

- A user launches a chosen native app from Cate; within a couple of seconds it appears **only** as a canvas panel (nothing on their real desktop; Dock icon aside).
- Canvas zoom/pan scales and clips it smoothly; other panels occlude it correctly.
- Resizing the panel re-lays-out the app crisply (not stretched).
- Clicking, typing, scrolling, and **right-click menus** all work and stay **inside** the panel.
- Capture stays live (no freeze) for the four spike apps over a multi-minute session.
- Killing the helper degrades the panel gracefully; closing the panel cleanly quits/detaches the app and tears down the virtual display.

## 12. Open questions

- Curated launch list vs. arbitrary "pick any .app" for MVP?
- One virtual display per app vs. one shared virtual display hosting multiple apps' windows (affects resource use at scale)?
- Persistence: on session restore, relaunch the app fresh, or only restore the panel placeholder and let the user re-launch?
- Audio: if a captured app plays audio, is that in scope at all for MVP? (Proposed: no — video + input only.)
