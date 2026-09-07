# Task Brief — Phase 0 Spike Harness (Native Apps on Canvas, macOS)

You are building a **throwaway feasibility spike**, not shippable code. It lives outside Cate's build. Its only job: produce a runnable Swift CLI a human can run by hand to answer 5 yes/no questions about whether "native macOS apps captured onto the Cate canvas" is viable. **You cannot run the observational parts yourself** (they need macOS permission grants and visual observation) — so your deliverable is *clean, compiling, runnable, well-instrumented* Swift that a human then executes. Print clear instructions to the console for what the human should observe at each step.

## Environment (already verified)
- macOS 26.5.2, Apple Swift 6.3.1, full Xcode at `/Applications/Xcode.app`.
- Target SwiftPM platform: `.macOS(.v14)` minimum (we run on 26, but 14 is the floor for stable `SCStream`/`SCContentSharingPicker`).

## Where to put it
- Create everything under `spike/nativehost-spike/` in this worktree.
- `Package.swift` — one executable target named `nativehost-spike`, no external dependencies (system frameworks only: ScreenCaptureKit, CoreGraphics, CoreMedia, CoreVideo, IOSurface, AppKit, ImageIO).

## The 5 questions the harness must let a human answer
1. **Liveness (highest risk):** does an app rendered on a headless `CGVirtualDisplay` keep producing LIVE ScreenCaptureKit frames (no App-Nap/occlusion freeze)?
2. **Transport:** can an `IOSurface` the tool produces be looked up + imported in another process? (For this spike, just prove the surface is IOSurface-backed and print its `IOSurfaceID`/global lookup works; full renderer import is a later manual step.)
3. **Input:** does a forwarded `CGEvent` click/keystroke land in the captured window?
4. **Child windows:** can a right-click menu be detected as a SEPARATE window owned by the target PID, with a readable frame relative to the main window?
5. **Permission attribution:** which app name do the Screen-Recording and Accessibility prompts show?

## Required structure — independent subcommands
Make `main.swift` dispatch on `CommandLine.arguments[1]` to independent probes, so the human runs each in isolation and observes:

- `enumerate` — print `SCShareableContent.current` displays + on-screen windows (title, ownerPID, frame). First run triggers the Screen-Recording prompt; print a line telling the human to note which app name the prompt shows (Q5).
- `virtualdisplay` — create a headless `CGVirtualDisplay` (see below), print its `CGDirectDisplayID` and bounds, then hold for 60s (RunLoop) so the human can confirm in System Settings > Displays that a phantom display exists and nothing appears on real screens. Q-supports 1.
- `capture <displayID|windowID>` — start an `SCStream` on the given target, write one PNG per second to `spike/nativehost-spike/out/frame-<n>.png` for 60s using `ImageIO`. Print the IOSurface id per frame if the sample buffer's pixel buffer is IOSurface-backed (Q2). The human watches whether successive PNGs keep changing (Q1 liveness).
- `input <windowID> <x> <y>` — post a `CGEvent` left click at window-local (x,y) mapped to global coords, then a test keystroke (types "hello"). First run triggers the Accessibility prompt; print a line to note the attributed app name (Q5). Q3.
- `childwindows <pid>` — every 500ms for 20s, print the window list for that PID via `CGWindowListCopyWindowInfo(.optionAll)` (kCGWindowOwnerPID filter), showing each window's number, layer, and bounds — so when the human right-clicks the app, a new menu window appears in the list (Q4).

Also support `help` / no-arg → print usage listing every subcommand with a one-line description and the exact observation the human should make.

## CGVirtualDisplay (private API) — how to declare it
`CGVirtualDisplay` and friends are private CoreGraphics ObjC classes (no public header). Declare the reverse-engineered interface in a dedicated file `Sources/nativehost-spike/CGVirtualDisplay.swift` using `@objc` protocol/class-dump-derived signatures, instantiating via the known initializers. The well-known interface is:
- `CGVirtualDisplayDescriptor` — properties: `name` (String), `maxPixelsWide`/`maxPixelsHigh` (UInt32), `sizeInMillimeters` (CGSize), `productID`/`vendorID`/`serialNum` (UInt32), `queue` (dispatch_queue), and a `terminationHandler`.
- `CGVirtualDisplaySettings` — `hiDPI` (UInt32), `modes` ([CGVirtualDisplayMode]).
- `CGVirtualDisplayMode` — `init(width:height:refreshRate:)`.
- `CGVirtualDisplay` — `init(descriptor:)`, `apply(_ settings:) -> Bool`, `displayID` (CGDirectDisplayID).

Add a clear comment block at the top of that file: this is a private, undocumented interface derived from public reverse-engineering of CoreGraphics; it may break across macOS releases; it is spike-only and must never ship as-is. If the runtime class can't be found via the direct declaration, fall back to `NSClassFromString("CGVirtualDisplay")` + KVC and log a clear error telling the human the private interface shape has changed on macOS 26.

**Do not block on getting this perfect.** If you're unsure a signature is exactly right, implement your best reverse-engineered version AND print rich diagnostics on failure (which class/selector failed) so the human's first run tells us what to fix. A spike that fails loudly with a precise error is a success.

## Launching an app onto the virtual display
Provide a helper (used by an optional `launch <bundleID-or-path> <displayID>` subcommand) that launches an app via `NSWorkspace.shared.openApplication` and, after a short delay, positions its main window onto the virtual display's bounds using the Accessibility API (`AXUIElement` set `kAXPositionAttribute`). If AX positioning is unreliable, document that clearly in console output and in FINDINGS — window placement is itself one of the risks.

## FINDINGS template
Create `spike/nativehost-spike/FINDINGS.md` with a filled-in skeleton: one section per question (Q1–Q5), each with "How to reproduce" (the exact command), "Expected observation", and an empty "Result: [ human fills in ]" line, plus a final "Gate: GO / RESHAPE / STOP" line. This is what the human completes after running.

## Deliverable / done criteria
- `cd spike/nativehost-spike && swift build` **compiles cleanly** (this is the one thing you CAN and MUST verify — run it, fix all errors/warnings you can).
- `swift run nativehost-spike help` runs and prints usage (verify this runs).
- Each subcommand is implemented and prints clear per-step observation instructions.
- `FINDINGS.md` skeleton present.
- Do NOT attempt to grant permissions, launch GUI apps for real observation, or claim any probe "passed" — you cannot observe them. Report build success + `help` output only as your verified evidence.

## Commits
Commit your work in this worktree. Suggested: `spike: nativehost feasibility harness (virtual display, capture, input, child windows)`. Do not add any AI/Claude attribution to the commit message.
