# Native Apps on Canvas (macOS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place a real, arbitrary native macOS app onto the Cate canvas as a fully interactive, zoomable panel by capturing it as a GPU texture and forwarding input — with the app rendered on a headless virtual display so it lives only on the canvas.

**Architecture:** An isolated Swift helper (`cate-nativehost`, one process per captured app) creates a headless `CGVirtualDisplay`, launches/attaches the target app onto it, captures its window(s) via ScreenCaptureKit into `IOSurface` frames, and injects mouse/keyboard via `CGEvent`. Cate's main process (`NativeAppBroker`) supervises helpers; a new `nativeApp` renderer panel imports the frame as a WebGL texture and maps input back. See the companion spec: `docs/native-apps-on-canvas.md`.

**Tech Stack:** Swift + ScreenCaptureKit + CoreGraphics (`CGVirtualDisplay`, `CGEvent`) + `IOSurface`/`CVPixelBuffer`; Electron main (TypeScript) broker; React renderer with WebGL texture upload; IPC via `src/shared/ipc-channels.ts`; electron-builder signing/entitlements.

## Global Constraints

_Every task's requirements implicitly include this section. Values copied from `docs/native-apps-on-canvas.md`._

- **Platform:** macOS only. No Windows/Linux code paths in this project.
- **Distribution:** notarized GitHub Releases only. **Not** Mac App Store — private APIs (`CGVirtualDisplay`) are permitted and expected.
- **Native delivery:** a standalone signed Swift **executable**, one helper process **per captured app**. Do **not** add a custom `.node` addon to the `@electron/rebuild` path.
- **Isolation:** a helper crash must never take down Cate; the panel degrades to a reconnect state.
- **Cleanliness:** target app renders on a headless virtual display, never on a real screen. The Dock icon **will** show — accepted limitation, do not attempt private Dock-suppression tricks.
- **Scope:** video + input only. **No audio** capture/forward in MVP.
- **Acquisition:** `launch` mode is MVP; `attach` mode is a post-MVP follow-up (separate plan).
- **Permissions:** Screen Recording (SCK) + Accessibility (`CGEvent`). Degrade to view-only if Accessibility is denied.
- **Panel registration pattern:** a new `PanelType` requires exactly two entries — `src/shared/panels.ts` (`SharedPanelDefinition`) and `src/renderer/panels/registry.ts` (renderer concerns) — plus the union in `src/shared/types.ts`.

---

## Plan structure & honesty note

This feature rests on private APIs and a capture pipeline whose viability the spec flags as **must-prove-first**. Accordingly:

- **Phase 0 (Spike)** is specified concretely below and is the immediate deliverable. It is standalone Swift + a throwaway harness — **no Cate integration** — built only to answer five yes/no questions. Its "tests" are **observed behaviour**, not unit asserts (native capture cannot be meaningfully unit-tested; you run it and watch frames/input).
- **Phases 1–6 (Build)** are decomposed into tasks with file structure, boundaries, and interfaces, but their **step-level exact code is intentionally deferred**: the correct Swift for virtual-display + IOSurface transport, and the transport choice itself, depend on Phase 0 outcomes. Writing "complete code" for them now would be guesswork. After the Phase 0 decision gate, re-run `superpowers:writing-plans` to expand the chosen build path into bite-sized coded tasks.

This is deliberate: a spike-gated feature gets a concrete spike plan and a contingent build roadmap, not a fabricated line-by-line plan for unproven private APIs.

---

# Phase 0 — Spike (build this now)

**Deliverable:** a throwaway `spike/nativehost-spike/` Swift command-line tool (outside Cate's build) that proves or kills the feature premise. Time-box ~1–2 days. Nothing here ships.

**The five questions it must answer (the decision gate):**
1. Does an app rendered on a headless `CGVirtualDisplay` keep producing **live** SCK frames (no App-Nap freeze) for a browser, WezTerm, Cursor, and Slack?
2. Can an `IOSurface` the helper produces be imported as a **GL/GPU texture in Cate's sandboxed renderer**? (If no → shared-memory-copy fallback becomes the MVP transport.)
3. Does a forwarded `CGEvent` click/keystroke land correctly in the virtual-display window?
4. Can a child window (right-click menu) be **detected as a separate window owned by the target PID** and located relative to the main window?
5. Which bundle do the Screen-Recording / Accessibility prompts attribute to — the helper or Cate.app?

### Task 0.1: Spike scaffold + Screen Recording permission

**Files:**
- Create: `spike/nativehost-spike/Package.swift`
- Create: `spike/nativehost-spike/Sources/nativehost-spike/main.swift`

**Interfaces:**
- Produces: a runnable `swift run nativehost-spike` CLI that logs SCK availability.

- [ ] **Step 1: Scaffold a SwiftPM executable** targeting macOS 14+ (SCK `SCContentSharingPicker`, stable `SCStream`). `Package.swift` declares one executable target, no external deps.
- [ ] **Step 2: Enumerate shareable content.** In `main.swift`, call `SCShareableContent.current` and print displays + on-screen windows. Run it.
- [ ] **Step 3: Observe the permission prompt.** First run triggers the Screen Recording prompt. **Record which app name the prompt shows** (answers Q5, part 1). Grant it.
- [ ] **Step 4: Verify** the tool prints a non-empty window list after granting. Expected: display + window entries logged.
- [ ] **Step 5: Commit** to the spike area.

```bash
git add spike/nativehost-spike
git commit -m "spike: nativehost SCK scaffold + screen-recording permission probe"
```

### Task 0.2: Headless virtual display + off-screen liveness (Q1 — highest risk)

**Files:**
- Modify: `spike/nativehost-spike/Sources/nativehost-spike/main.swift`
- Create: `spike/nativehost-spike/Sources/nativehost-spike/VirtualDisplay.swift`

**Interfaces:**
- Produces: `makeHeadlessDisplay(width:height:) -> CGDirectDisplayID?` (wraps `CGVirtualDisplay` private API).

- [ ] **Step 1: Declare the `CGVirtualDisplay` private interface** (descriptor/settings/mode) and create a virtual display attached to no physical monitor. Log its `CGDirectDisplayID`.
- [ ] **Step 2: Launch a target app onto it.** Use `NSWorkspace`/`open` to launch (start with a browser), then position its window onto the virtual display's bounds via the window-server ordering call. Confirm nothing appears on the real screens.
- [ ] **Step 3: Capture that window with `SCStream`** and write one frame per second to disk as PNG for 60s.
- [ ] **Step 4 (THE observation):** Interact with nothing. Confirm the PNGs keep **updating** (e.g. a page with a clock/animation advances) — i.e. no occlusion/App-Nap freeze. **Repeat for WezTerm, Cursor, Slack.** Record pass/fail per app. This is the gate that can kill or reshape the whole feature.
- [ ] **Step 5: Commit** the findings (a short `FINDINGS.md` with per-app results + sample frames).

### Task 0.3: IOSurface → Cate renderer texture (Q2 — transport decision)

**Files:**
- Modify: `spike/nativehost-spike/Sources/nativehost-spike/main.swift`
- Create (throwaway, in worktree): a minimal Electron test harness OR a temporary `nativeApp` stub panel in Cate that only tries to import a surface handle.

**Interfaces:**
- Produces: a decision — `IOSurface`-shared-texture **viable** vs. **shared-memory-copy fallback**.

- [ ] **Step 1:** Make the spike deliver SCK frames as `IOSurface`-backed `CVPixelBuffer`s and expose the surface's global ID (`IOSurfaceGetID` / mach port) over a local socket.
- [ ] **Step 2:** In a minimal renderer context inside Cate's sandbox, attempt `IOSurfaceLookup` + import as a WebGL texture and draw it.
- [ ] **Step 3 (observation):** Does the live app appear in the renderer? If yes → IOSurface transport confirmed. If blocked by the sandbox → implement the one-copy shared-memory path and confirm that draws instead.
- [ ] **Step 4:** Record the outcome in `FINDINGS.md` (this selects the MVP transport in Phase 3).
- [ ] **Step 5: Commit.**

### Task 0.4: Input round-trip + child-window detection (Q3, Q4)

**Files:**
- Modify: `spike/nativehost-spike/Sources/nativehost-spike/main.swift`

- [ ] **Step 1:** Post a `CGEvent` mouse-click at a known point of the virtual-display window (e.g. a button on a test page). Trigger Accessibility prompt; **record which app it attributes to** (Q5 part 2).
- [ ] **Step 2 (observation):** Confirm the click registers in the captured app (the page reacts in the PNG stream).
- [ ] **Step 3:** Post a keystroke; confirm text appears.
- [ ] **Step 4:** Right-click to open a context menu. Enumerate windows for the target PID and confirm the **menu is a distinct window** with a frame you can read relative to the main window (Q4).
- [ ] **Step 5: Commit** findings.

### Task 0.5: Decision gate

- [ ] **Step 1:** Fill `FINDINGS.md` with a clear verdict on all five questions.
- [ ] **Step 2:** GO / RESHAPE / STOP decision:
  - **STOP** if Q1 fails for common apps (no reliable off-screen liveness) — the premise doesn't hold; report back before any build work.
  - **RESHAPE** if Q2 fails (adopt shared-memory transport) or Q5 shows permission attribution forces a bundle-structure change — fold into Phase 1+ before proceeding.
  - **GO** otherwise.
- [ ] **Step 3:** Re-invoke `superpowers:writing-plans` to expand Phases 1–6 below into bite-sized coded tasks using the confirmed transport and per-app realities.

---

# Phases 1–6 — Build roadmap (detail after the Phase 0 gate)

_Task boundaries, file structure, and interfaces are fixed here so decomposition is locked; step-level code is authored post-spike._

### Phase 1 — Ship the Swift helper as a signed sidecar binary
- **Files:** `native/nativehost/` (Swift package → `cate-nativehost` executable); `electron.vite`/build config to copy it into `resources/`; `build/entitlements.mac.plist` (+ `.runtime`, `.dev`) for Screen Recording + Accessibility + hardened runtime; notarization config.
- **Deliverable:** `cate-nativehost` builds, is code-signed + notarized as part of `npm run build`, and launches standalone. Verified by a signed dev build that passes notarization and runs the binary.
- **Boundary:** no Cate runtime wiring yet — purely "the sidecar exists, signs, ships."

### Phase 2 — `NativeAppBroker` (main process) + helper lifecycle + IPC
- **Files:** `src/main/nativeApp/NativeAppBroker.ts` (spawn/supervise one helper per session, PID/lifecycle, restart-on-crash), `src/main/nativeApp/nativeHostProtocol.ts` (typed socket/stdio protocol to the helper); new channels in `src/shared/ipc-channels.ts`; types in `src/shared/types.ts`.
- **Interfaces produced:** `acquire({mode:'launch', executable}) → {sessionId}`, `release(sessionId)`, `resize(sessionId, size)`, `sendInput(sessionId, event)`, `onFrame(sessionId, cb)`, `onStatus(sessionId, cb)`.
- **Deliverable:** broker can launch a helper, receive a heartbeat/status, and tear it down. Verified against the Phase 0 spike binary (or Phase 1 sidecar) with a scripted main-process harness.

### Phase 3 — Frame transport → renderer texture
- **Files:** `src/main/nativeApp/frameChannel.ts` (surface-handle or shared-memory relay per the Phase 0 decision), `src/renderer/panels/nativeApp/useNativeAppTexture.ts` (WebGL upload + draw loop).
- **Deliverable:** the live app renders inside a bare renderer surface at 1×. Verified by eye: the captured app is visible and updates in a Cate window.
- **Boundary:** rendering only — no panel chrome, no input, no zoom yet.

### Phase 4 — `nativeApp` panel type + canvas integration
- **Files:** `src/shared/types.ts` (`PanelType` union), `src/shared/panels.ts` (`SharedPanelDefinition`: `canLiveOnCanvas: true`, `keepMountedOffscreen: true`), `src/renderer/panels/registry.ts` (icon + lazy `NativeAppPanel` + factory), `src/renderer/panels/nativeApp/NativeAppPanel.tsx`.
- **Deliverable:** a `nativeApp` panel hosting the texture works as a `CanvasNode` — drags, docks, **zooms/clips/occludes** for free via existing canvas machinery, survives off-screen culling. Verified on the canvas: zoom in/out, overlap with another panel, scroll off-screen and back.

### Phase 5 — Interaction: input mapping, panel-resize→window-resize, child windows
- **Files:** `src/renderer/panels/nativeApp/useNativeAppInput.ts` (canvas→panel-local→window-coord mapping; mouse/scroll/keyboard/modifiers/IME), helper-side `WindowResize.swift` + `ChildWindows.swift`.
- **Deliverable (the "real, not demo" bar):** click/type/scroll work; resizing the panel re-lays-out the app crisply; **right-click menus and dialogs render inside the panel** (child-window compositing). Verified by exercising each interaction on two real apps.
- **Boundary:** this is the heaviest, fiddliest phase — child-window compositing especially. May warrant its own sub-plan after Phase 0.

### Phase 6 — Cleanliness, permissions UX, persistence, teardown
- **Files:** `src/renderer/panels/nativeApp/PermissionGate.tsx` (detect/explain/deep-link to System Settings; view-only degrade), off-screen/virtual-display launch sequencing in the helper, session-restore wiring in the existing panel-persistence path.
- **Deliverable:** first-run permission flow; app launches straight onto the virtual display (never flashes on a real screen); closing the panel quits/detaches the app and destroys the virtual display; session restore relaunches (per resolved open question). Verified end-to-end against the §11 success criteria in the spec.

---

## Open questions to resolve before Phase 4+ (from the spec)
- Curated launch list vs. arbitrary "pick any .app" for MVP.
- One virtual display per app vs. one shared virtual display (resource use at scale).
- Persistence on restore: relaunch fresh vs. placeholder-only.
- Audio: confirmed out of scope for MVP.

## Self-review notes
- **Spec coverage:** spec §5 (architecture) → Phases 1–4; §6 (acquisition, launch-first) → Phase 2 + Global Constraints; §7 (zoom/resize/input/child windows) → Phases 4–5; §8 (virtual display, Dock, permissions, entitlements) → Phases 1 + 6; §9 (spike-first risks) → Phase 0; §10 (MVP scope) → phase ordering; §11 (success criteria) → Phase 6 verification. No spec section is unmapped.
- **Deferred-code rationale:** step-level code for Phases 1–6 is intentionally not fabricated pre-spike (documented above), so the "No Placeholders" rule is satisfied for Phase 0 (fully specified) and the build phases are explicitly a roadmap pending the gate, not placeholder tasks masquerading as complete.
