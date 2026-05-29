#!/usr/bin/env bash
# =============================================================================
# perf-sample.sh — macOS battery/heat triage for Cate.
#
# Samples per-second CPU for WindowServer (the macOS compositor) and all Cate
# processes (main + renderer + GPU helpers), so you can tell WHERE the cost is
# when the app feels hot:
#
#   - WindowServer climbs while Cate is busy  -> compositor cost (translucency,
#     blur, continuous repaints, GPU layers). Fix in the renderer/CSS/window.
#   - a Cate process climbs                   -> app CPU (which process tells you
#     main=IPC/polling, a renderer helper=a panel like xterm/Monaco).
#   - neither climbs                           -> Cate isn't the drain.
#
# Run it FOREGROUND while reproducing the heat (Cate window frontmost, not
# occluded — macOS throttles compositing for hidden windows, which skews things).
#
#   bash scripts/perf-sample.sh [seconds]      # default 20
# =============================================================================

set -euo pipefail
DUR="${1:-20}"
# top's first sample reports cumulative-since-boot values, so take DUR+1 and skip it.
SAMPLES=$((DUR + 1))

echo "Sampling WindowServer + Cate for ${DUR}s (1s interval). Keep the Cate window frontmost..."
echo

top -l "$SAMPLES" -s 1 -stats command,cpu 2>/dev/null | awk '
  /^Processes:/ {
    if (sample > 1) printf "  t+%-3d  WindowServer=%5.1f%%   Cate(all)=%5.1f%%\n", sample-2, ws, cate
    if (sample > 1) { if (ws  > wsmax)  wsmax  = ws;  if (cate > catemax) catemax = cate }
    ws = 0; cate = 0; sample++
  }
  /WindowServer/        { ws = $NF + 0 }
  $1 == "Cate"          { cate += $NF + 0 }
  END {
    printf "\n  PEAK   WindowServer=%5.1f%%   Cate(all)=%5.1f%%\n", wsmax, catemax
    print  ""
    print  "Read: WindowServer peak high + Cate low  -> compositor (CSS blur/translucency, repaints)."
    print  "      Cate peak high                      -> app CPU; rerun Cate with CATE_PERF=1 + open the HUD (Cmd+Alt+P) to see which process/path."
  }
'
