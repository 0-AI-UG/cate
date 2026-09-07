# Native Apps on Canvas (macOS) — Full Build Plan

> Supersedes the "Phases 1–6 roadmap" in `native-apps-on-canvas-plan.md`. Design: `native-apps-on-canvas.md`. Tracks #122.
> Decision (2026-07-14): skip the remaining standalone-spike verification and build the real feature. The riskiest unknown — headless `CGVirtualDisplay` — is already **proven** on macOS 26 (spike created real displays, no crash). Remaining unknowns (real-app liveness off-screen, transport) are answered **inside Milestone 1** rather than in a throwaway harness.

**Goal:** launch a real native macOS app that lives only on the Cate canvas as a zoomable, interactive panel.

**Strategy: vertical slices, testable in-app at every milestone.** Each milestone ends with something you build (`runtime:tarball` + `dev`) and see working. Milestone 1 is view-only but proves the whole pipeline (and the liveness question) end-to-end.

## Key architecture decisions (made, not deferred)

1. **Isolated Swift sidecar** `cate-nativehost`, one process per captured app (spec §5.2). Spawned/supervised by a main-process `NativeAppBroker`.
2. **Transport — start simple, optimize later.** Milestone 1 ships **JPEG-per-frame over a local UNIX-domain socket** (sidecar encodes via ImageIO; main relays the compressed buffer to the renderer; renderer draws via `createImageBitmap`). ~100–300 KB/frame at 10–15 fps — trivially within a local socket + IPC budget, and it **sidesteps the unverified IOSurface-in-sandbox risk entirely**. Zero-copy `IOSurface`/H.264-via-WebCodecs is **Milestone 5**, behind the same renderer interface, once the product works.
3. **App lives on a headless `CGVirtualDisplay`** (proven). Launch mode only for MVP (`attach` later).
4. **New `nativeApp` panel type** slots into Cate's existing data-driven panel system; `canLiveOnCanvas: true`, `keepMountedOffscreen: true`.
5. **Dock icon shows** — accepted. No audio — out of scope.

## Milestones

### Milestone 1 — Vertical slice: an app, live and zoomable on the canvas (view-only)
Proves capture→transport→render end-to-end AND answers real-app liveness for real.
- **1a. Sidecar capture server.** Productionize the spike into `native/nativehost/` → `cate-nativehost`. Subcommand/mode `serve --bundle <id> --socket <path> [--width --height --fps]`: create virtual display → launch app onto it (AX placement with retry-until-window-ready + fallback) → confirm window landed on the display → `SCStream` capture → JPEG-encode each frame → length-prefixed frames over the UNIX socket. Emits a small JSON control channel (ready, displayId, appPid, frameStatus tally, errors). Clean shutdown quits the app + destroys the display.
- **1b. NativeAppBroker (main).** `src/main/nativeApp/NativeAppBroker.ts`: spawn one sidecar per session, own its socket, parse the framed protocol (`nativeHostProtocol.ts`), supervise/restart on crash. New IPC channels in `ipc-channels.ts`: `nativeApp:acquire`, `nativeApp:release`, `nativeApp:frame` (main→renderer), `nativeApp:status`.
- **1c. Renderer panel.** Add `nativeApp` to `PanelType` (`shared/types.ts`) + `panels.ts` + `registry.ts`. `src/renderer/panels/nativeApp/NativeAppPanel.tsx`: subscribe to frames, draw the latest into a `<canvas>` sized to the panel; hosted in a `CanvasNode` so zoom/clip/occlude come free. A simple launcher (pick a bundle id / from a short list) calls `nativeApp:acquire`.
- **Deliverable/test:** launch (say) Safari from a nativeApp panel → it appears live on the canvas, updates as the page animates, zooms/pans/occludes like any panel. **This is the liveness gate, now in-product.** Grant Screen-Recording once.

### Milestone 2 — Interaction: mouse + keyboard
- Renderer maps canvas-space pointer → panel-local → source-window coords; sends `nativeApp:input` events. Sidecar injects via `CGEvent` (click/drag/scroll/keys/modifiers). Basic IME text.
- **Test:** click links, type in a field, scroll — inside the panel. Grant Accessibility once.

### Milestone 3 — Fidelity: resize + child windows
- Panel resize → sidecar resizes the real window (retina backing scale) → recapture crisp.
- Sidecar detects windows owned by the app PID; composites child windows (menus, tooltips, dialogs) into the same panel at correct relative offsets so right-click menus land **inside** the canvas (spec §7.5 — the demo→real bar).
- **Test:** resize reflows content; right-click menu appears in-panel.

### Milestone 4 — Cleanliness, permissions UX, lifecycle
- First-run `PermissionGate` (detect/explain/deep-link System Settings; view-only degrade if Accessibility denied). App launches straight onto the virtual display (never flashes on a real screen). Closing the panel quits/detaches the app + tears down the display. Session-restore relaunch. Dock-icon limitation documented in-UI.

### Milestone 5 — Performance transport
- Replace JPEG-over-socket with zero-copy `IOSurface`→WebGL (or H.264→WebCodecs) behind the Milestone-1 renderer interface. Multi-panel concurrency + frame pacing.

### Milestone 6 — Ship: signing & notarization
- `native/nativehost/` builds in `npm run build`; `cate-nativehost` code-signed + notarized; entitlements (`build/entitlements*.plist`) + Info.plist usage strings for Screen Recording + Accessibility; hardened runtime passes notarization.

## Execution
Subagent-driven, one implementer per task, controller (me) verifies each `swift build` / `tsc` / `vitest` before proceeding; ledger at `.superpowers/sdd/progress.md`. Native runtime behavior is verified by **Paul running the built app** (permission grants + observation) — reported back for iteration. Milestones 1–4 are the product; 5–6 harden/ship it.

## Honest risk register
- **Real-app liveness off-screen** — proven for empty desktop (0 suspended/60s); Milestone 1 confirms for real apps. If a common app freezes, Milestone 4 adds per-app keep-alive / falls back to on-a-real-but-offscreen-display.
- **AX window placement onto an invisible display** (`-25200` seen in a non-GUI context) — Milestone 1a hardens with retries + a window-server-move fallback; needs Accessibility granted.
- **IOSurface-in-sandbox** — deliberately NOT on the critical path (JPEG transport first).
- **Child-window compositing** (Milestone 3) — the fiddliest UX; may warrant its own sub-plan.
