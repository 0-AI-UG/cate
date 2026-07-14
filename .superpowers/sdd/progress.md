# Native Apps on Canvas — SDD Progress Ledger

Worktree: .claude/worktrees/native-window-support
Branch: worktree-native-window-support
Build plan: docs/native-apps-on-canvas-build-plan.md

## Proven (spike, retired)
- Headless CGVirtualDisplay works on macOS 26 (real displayIDs, no crash).
- SCK capture of the virtual display runs 60s, 0 suspended (empty desktop).
- Selector: CGVirtualDisplay uses -applySettings:. Backtracer: SWIFT_BACKTRACE=enable=no.

## Decision
Build the full feature (Paul, 2026-07-14). Vertical slices; liveness confirmed
in-product at Milestone 1. Transport: JPEG-over-UNIX-socket first.

## Milestone 1 — view-only slice (an app live+zoomable on canvas)
- [x] 1a. Sidecar capture server DONE (5ef4fc8): builds clean; launches app onto virtual display (onDisplay:true), captures, streams JPEG frames over UNIX socket. Protocol in native/nativehost/PROTOCOL.md.
- [x] 1b. NativeAppBroker + IPC DONE (2e1aa52): decoder 8/8, tsc clean, real sidecar frames reach Node. API: electronAPI.nativeAppAcquire/nativeAppRelease + onNativeAppFrame/onNativeAppStatus.
- [x] 1c. nativeApp panel + renderer DONE (f094779): panel draws live JPEG frames; open via New Native App. Full suite 2500 green.
- [~] M1 in-app test: AWAITING PAUL (npm run dev, open New Native App, grant Screen Recording).

## Later milestones: 2 input, 3 resize+child-windows, 4 lifecycle/perms, 5 IOSurface perf, 6 sign+notarize
