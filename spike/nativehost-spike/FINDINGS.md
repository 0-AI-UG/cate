# nativehost-spike — Findings (Phase 0, native apps on canvas, issue #122)

This is a throwaway feasibility spike. The Swift CLI in this directory implements
best-effort, independently-runnable probes for the 5 questions below. Each probe
prints its own console instructions for what to observe. **A human must run each
command and fill in the "Result" line** — the agent that wrote this harness could
not grant macOS permissions or visually observe capture/liveness/input, so none of
these have been verified end-to-end.

Build/run from `spike/nativehost-spike/`:

```
swift build
swift run nativehost-spike help
```

---

## Q1 — Liveness (highest risk)

Does an app rendered on a headless `CGVirtualDisplay` keep producing LIVE
ScreenCaptureKit frames (no App-Nap/occlusion freeze)?

**Note for the human running this:** Swift's interactive crash backtracer will hang
these commands on a "Press space… 30s" prompt if the process ever crashes/traps.
Always prefix probe runs with `SWIFT_BACKTRACE=enable=no`, e.g.
`SWIFT_BACKTRACE=enable=no swift run nativehost-spike virtualdisplay`, so a crash
fails fast instead of hanging your terminal for 30 seconds waiting for input.

**How to reproduce (preferred — one command, automatic verdict):**
```
SWIFT_BACKTRACE=enable=no swift run nativehost-spike livecheck [bundleID]
```
`livecheck` does everything in a single process (so the virtual display's
process-tied lifetime is held for the whole test): creates the virtual display,
launches `bundleID` (default `com.apple.Safari`), AX-repositions its main window
onto the display, confirms via `CGWindowListCopyWindowInfo` that the window
actually landed there, then runs an `SCStream` on the virtual display for 60s
tallying `SCFrameStatus` per frame (complete/idle/blank/suspended/started/stopped)
plus a cheap pixel-subsample hash for a distinct-frame count. It prints a tally
every 10s and ends with an automatic **GO/LIVE**, **NO-GO/FROZEN**, or
**INCONCLUSIVE** verdict — no manual PNG diffing required. If step 4 (confirm
on-display) reports NO, the verdict is INCONCLUSIVE and it says so — re-run with
a different `bundleID`, or manually drag a window onto the virtual display bounds
first (see the printed bounds).

**Manual fallback (older, 3-process, requires PNG diffing):**
```
swift run nativehost-spike virtualdisplay
# note the printed CGDirectDisplayID, then in a second terminal:
swift run nativehost-spike launch com.apple.TextEdit <displayID>
# in a third terminal:
swift run nativehost-spike capture <displayID>
```
**Expected observation:** `out/frame-*.png` files are written once per second for
60s. Open several of them (e.g. `frame-5.png`, `frame-30.png`, `frame-55.png`) and
compare — if the app is animating/blinking a cursor/etc., later frames should
differ from earlier ones. If frames stop changing after a few seconds even though
the source app should still be updating, that's App Nap or occlusion-based frame
throttling — the core risk this question is about.

**Result:** [ human fills in — run `livecheck` and paste the VERDICT line here.
Note: an agent test run in this repo's dev environment got as far as a clean
INCONCLUSIVE verdict (AX repositioning failed with -25200 in that sandboxed
context, so the app never landed on the virtual display) — the capture pipeline
itself ran end-to-end for the full 60s with real ScreenCaptureKit frames
(total=500, complete=12, idle=488, 0 suspended), so Screen Recording + the
SCStream plumbing are confirmed working; only the "does the app itself stay
live" verdict still needs a human run with a window actually on the display. ]

---

## Q2 — Transport

Can an `IOSurface` the tool produces be looked up + imported in another process?
(This spike only proves the surface is IOSurface-backed and that `IOSurfaceID`
global lookup works within the same process; full cross-process renderer import is
a later manual step, not implemented here.)

**How to reproduce:**
```
swift run nativehost-spike enumerate   # find a displayID or windowID
swift run nativehost-spike capture <displayID|windowID>
```

**Expected observation:** console lines of the form
`[capture] frame N: IOSurface-backed. IOSurfaceID=<id> globalLookupSucceeded=true`
for each saved frame.

**Result:** [ human fills in ]

---

## Q3 — Input

Does a forwarded `CGEvent` click/keystroke land in the captured window?

**How to reproduce:**
```
swift run nativehost-spike enumerate   # find a windowID for the target app
swift run nativehost-spike input <windowID> <x> <y>
```

**Expected observation:** the target window receives a left click at the given
window-local coordinate (e.g. focuses a text field under the cursor), then the
literal characters "hello" appear wherever focus landed.

**Result:** [ human fills in ]

---

## Q4 — Child windows

Can a right-click menu be detected as a SEPARATE window owned by the target PID,
with a readable frame relative to the main window?

**How to reproduce:**
```
swift run nativehost-spike enumerate   # find the ownerPID for the target app
swift run nativehost-spike childwindows <pid>
# right-click inside the target app while this is running
```

**Expected observation:** a new line prefixed `NEW=` appears in the console with a
window number not present in earlier polls, and its `bounds=` rect is positioned
near where you right-clicked (context menus are typically small, high-layer
windows separate from the main window).

**Result:** [ human fills in ]

---

## Q5 — Permission attribution

Which app name do the Screen-Recording and Accessibility prompts show?

**How to reproduce:**
```
swift run nativehost-spike enumerate   # first run triggers Screen Recording prompt
swift run nativehost-spike input <windowID> <x> <y>   # first run triggers Accessibility prompt
```
(If permission was already granted to this binary from a prior run, reset with
`tccutil reset ScreenCapture` / `tccutil reset Accessibility` to see the prompt
again, or check System Settings > Privacy & Security > Screen Recording /
Accessibility for which entry corresponds to this binary.)

**Expected observation:** note the exact app name/icon shown in each system
prompt (e.g. "nativehost-spike", "Terminal", "swift-frontend" — SwiftPM-run CLIs
often get attributed to the terminal or toolchain process that launched them
rather than the binary itself, which matters for how Cate would need to package
this for real).

**Result:** [ human fills in ]

---

## Gate

**Gate: GO / RESHAPE / STOP** — [ human fills in after completing Q1–Q5 ]
