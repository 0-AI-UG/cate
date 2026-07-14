//
//  main.swift — nativehost-spike entry point.
//
//  THROWAWAY Phase 0 feasibility spike for "native apps on canvas" (issue #122).
//  Not part of Cate's build; must never ship. Dispatches CommandLine.arguments[1]
//  to an independent probe subcommand. See printUsage() below for the full list.
//

import Foundation

func printUsage() {
    print("""
    nativehost-spike — macOS native-window-capture feasibility probes (Phase 0 spike)
    THROWAWAY CODE. Not part of Cate's build. Never ship as-is.

    USAGE:
      swift run nativehost-spike <subcommand> [args...]

    SUBCOMMANDS:

      enumerate
          Prints SCShareableContent.current displays + on-screen windows (title,
          ownerPID, frame). First run triggers the Screen-Recording permission
          prompt.
          OBSERVE (Q5): note which app name the permission prompt attributes this
          request to (Terminal? nativehost-spike? Xcode?).

      virtualdisplay
          Creates a headless CGVirtualDisplay (private API), prints its
          CGDirectDisplayID + bounds, then holds for 60s via RunLoop.
          OBSERVE (Q1 support): open System Settings > Displays while this runs
          and confirm a phantom display named "Cate Spike Virtual Display"
          appears, and that nothing is mirrored onto your real screens.

      capture <displayID|windowID>
          Starts an SCStream on the given target (matches a display ID first,
          else a window ID from 'enumerate'). Writes one PNG per second to
          spike/nativehost-spike/out/frame-<n>.png for 60s. Prints the frame's
          IOSurfaceID and whether IOSurfaceLookup succeeds, per frame.
          OBSERVE (Q2 transport): the IOSurfaceID + lookup lines confirm the
          buffer is IOSurface-backed and globally lookup-able.
          OBSERVE (Q1 liveness): diff successive PNGs in out/ — do they keep
          changing over the full 60s, or freeze after a few seconds (App Nap /
          occlusion)?

      input <windowID> <x> <y>
          Posts a CGEvent left-click at window-local (x,y) (mapped to global
          coords via the window's on-screen frame), then types the fixed test
          string "hello". First run triggers the Accessibility permission
          prompt.
          OBSERVE (Q5): note which app name the Accessibility prompt attributes
          this request to.
          OBSERVE (Q3): does the click/keystroke actually land in the target
          window?

      childwindows <pid>
          Every 500ms for 20s, prints CGWindowListCopyWindowInfo(.optionAll)
          entries owned by <pid> (window number, layer, bounds).
          OBSERVE (Q4): right-click inside the target app during the 20s window
          — does a NEW window entry appear (a separate context-menu window),
          with a bounds rect near your click?

      launch <bundleID-or-path> <displayID>
          Optional helper. Launches the given app via NSWorkspace, waits ~2s,
          then attempts to reposition its main window onto the given display's
          bounds via the Accessibility API (AXUIElementSetAttributeValue
          kAXPositionAttribute). Best-effort; prints whether the AX call
          reported success.
          OBSERVE: does the app's window visually relocate onto the target
          display bounds?

      help
          Prints this usage text.

    THE 5 FEASIBILITY QUESTIONS (see FINDINGS.md for the full template):
      Q1 Liveness      — virtualdisplay + capture
      Q2 Transport      — capture (IOSurfaceID / lookup lines)
      Q3 Input          — input
      Q4 Child windows  — childwindows
      Q5 Permission attribution — enumerate + input (first-run prompts)
    """)
}

let arguments = CommandLine.arguments
let command = arguments.count > 1 ? arguments[1] : "help"

switch command {
case "enumerate":
    runEnumerate()

case "virtualdisplay":
    runVirtualDisplay()

case "capture":
    guard arguments.count > 2 else {
        print("ERROR: capture requires <displayID|windowID>\n")
        printUsage()
        exit(64)
    }
    runCapture(targetArg: arguments[2])

case "input":
    guard arguments.count > 4,
          let windowID = UInt32(arguments[2]),
          let x = Double(arguments[3]),
          let y = Double(arguments[4])
    else {
        print("ERROR: input requires <windowID> <x> <y> (numeric)\n")
        printUsage()
        exit(64)
    }
    runInput(windowID: windowID, x: x, y: y)

case "childwindows":
    guard arguments.count > 2, let pid = Int32(arguments[2]) else {
        print("ERROR: childwindows requires <pid> (numeric)\n")
        printUsage()
        exit(64)
    }
    runChildWindows(pid: pid)

case "launch":
    guard arguments.count > 3 else {
        print("ERROR: launch requires <bundleID-or-path> <displayID>\n")
        printUsage()
        exit(64)
    }
    runLaunch(bundleIDOrPath: arguments[2], displayIDArg: arguments[3])

case "help", "-h", "--help":
    printUsage()

default:
    print("Unknown subcommand: \(command)\n")
    printUsage()
    exit(64)
}
