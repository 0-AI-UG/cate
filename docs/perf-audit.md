# Cate Performance Audit

Static performance audit across all subsystems (canvas/rendering, terminal+pty,
Monaco editor, zustand/re-renders, main process I/O, agent/chat). Each finding
below was produced by a per-subsystem analyzer reading the real code and then
adversarially verified by a separate skeptic pass — 37 of 44 raw findings
survived verification.

To **measure** any of these on your machine, launch with the profiler:

```bash
CATE_PERF=1 npm run dev
```

This mounts a live HUD (toggle with ⌘⌥P) showing per-process CPU/mem,
subprocess spawn rates, IPC bytes/channel, terminal throughput, FPS, long tasks,
and renders/sec for the hot components. See "Profiling layer" at the bottom.

---

## Executive summary

Three subsystems dominate, all on continuous-use paths:

- **Agent chat streaming (CPU + memory)** — the single most concentrated
  hotspot. Every streamed token rebuilds the messages array, re-renders the
  whole `AgentPanel → ChatThread`, and re-parses markdown for *every* assistant
  message (no `React.memo`, no virtualization, no delta batching). An auto-scroll
  effect forces a synchronous layout per token. Transcript + large tool outputs
  grow unbounded with a per-message quadratic string concat.
- **Canvas interaction (CPU + main-thread)** — pan/zoom/drag churn the main
  thread ~60×/s. `useVisibleNodeIds` re-allocates and re-sorts every node
  (`O(n log n)`) on every store emission; smooth-zoom fans a changing
  `zoomLevel` prop into every mounted `CanvasNode` (pure waste — transforms are
  applied imperatively); region drag/resize and right-click pan write to the
  store on every raw mousemove with no rAF coalescing.
- **Main-process I/O (CPU + battery)** — synchronous `statSync`+`appendFileSync`
  per ~4KB of PTY output blocks the event loop on the data-forwarding callback;
  a process-tree poll spawns `pgrep`/`ps` every 1s even when backgrounded; git
  monitor and worktree status fan out multiple git subprocesses per poll/refresh.

Secondary: Monaco keeps up to 20 closed-file models resident with no large-file
guard; several zustand selectors over-subscribe; terminal WebGL contexts are
rebuilt on every visibility toggle.

---

## Ranked issues

| # | Subsystem | Issue | Resource | Sev | Effort | Expected win |
|---|-----------|-------|----------|-----|--------|--------------|
| 1 | agent+chat | ChatThread re-renders + re-parses all markdown per streamed token (no memo/virtualization) | CPU | med | M | O(N msgs)/token → O(1) |
| 2 | terminal+pty | Synchronous `statSync`+`appendFileSync` per 4KB PTY output blocks main loop | main-thread | med | S | Removes sync disk I/O from hot path |
| 3 | main+ipc+io | Process-tree activity poll spawns `pgrep`/`ps` every 1s even when backgrounded | CPU | med | S | Cuts idle/background CPU + battery |
| 4 | canvas | Smooth zoom re-renders every visible CanvasNode each frame via `zoomLevel` prop | CPU | med | M | Eliminates per-node re-render during zoom |
| 5 | canvas | `useVisibleNodeIds` re-sorts + re-allocates all nodes on every store emission | main-thread | med | M | Removes O(n log n) sort from every frame |
| 6 | canvas | Region drag/resize writes to store per mousemove (no rAF) | CPU | med | S | Caps store writes to 1/frame |
| 7 | canvas | Right-click/middle pan writes viewportOffset per mousemove (no rAF) | CPU | med | S | Caps pan writes to 1/frame |
| 8 | agent+chat | Auto-scroll effect forces synchronous layout every token | main-thread | med | S | Removes forced reflow per token |
| 9 | agent+chat | Unbounded transcript + full-array copy + quadratic string concat per token | memory | med | M | Bounds renderer memory; removes O(n²) |
| 10 | agent+chat | No virtualization for long message lists | main-thread | med | L | Caps mount/reconcile to viewport |
| 11 | main+ipc+io | Git monitor spawns 3 git subprocesses per poll; fs-watch pins 2s floor | CPU | med | S | Fewer git spawns/sec on busy repos |
| 12 | main+ipc+io | `GIT_WORKTREE_STATUS` runs full status + rev-list per worktree on refresh | CPU | med | M | Cuts per-refresh git fan-out |
| 13 | main+ipc+io | `FS_SEARCH` reads full file contents, no concurrency/byte budget | memory | med | M | Bounds search CPU/latency |
| 14 | terminal+pty | WebGL addon disposed + recreated on every visibility re-attach | gpu | med | S | Avoids GPU context churn on pan |
| 15 | terminal+pty | URL auto-open ANSI-strips + scans every PTY chunk (default on) | CPU | med | S | Removes full-chunk alloc on hot path |
| 16 | monaco | No large-file guard: full read + tokenize + wordWrap | main-thread | med | S | Prevents multi-second UI freeze |
| 17 | monaco | LRU model cache holds 20 closed-file TextModels resident | memory | low | S | Bounds idle editor memory |
| 18 | terminal+pty | Body-spinner regex runs on every PTY chunk, no presence gate | CPU | low | S | Skips alloc+regex for non-agent terminals |
| 19 | zustand | EditorPanel subscribes to entire `workspaces` array | CPU | low | S | Avoids re-render on unrelated mutations |
| 20 | canvas | `CanvasRegionComponent` re-parses `region.color` ~20×/render | CPU | low | S | 20 regex → 1 per render |

---

## Issue detail & fixes

> **Status:** #4 (zoom) and #2 (terminal log I/O) are **fixed** — see their
> entries below and the before/after table above. The `setTerminalActivity`
> dedup (status-store no-op emits) is also fixed. Remaining items are open.

### 1. ChatThread re-renders + re-parses markdown per token
`src/agent/renderer/ChatThread.tsx:119-167, 342-406`; `AgentPanel.tsx:150-167`; `agentStore.ts:358-373`
- **Wrong:** `appendAssistantDelta` returns a fresh `messages` array per token; `AgentPanel` subscribes to the whole slice; `ChatThread` (no memo) re-runs `messages.map` → `MessageRow` (no memo) → `<ReactMarkdown remarkPlugins={[remarkGfm]} components={{...}}>` with inline plugin array/components object, re-parsing every assistant message's markdown every token.
- **Fix:** `React.memo` `MessageRow` keyed on message id; hoist `components`/`remarkPlugins` to module constants; `useMemo(() => <ReactMarkdown .../>, [text])`; narrow the `AgentPanel` selector to the streaming tail. Only the actively streaming message then re-parses.

### 2. Synchronous fs writes per 4KB PTY output — ✅ FIXED
`src/main/ipc/terminalLogger.ts`; caller `terminal.ts` `onData`
- **Was:** `append()` flushed at 4KB via `fs.statSync` + `fs.appendFileSync` — both synchronous, on the main loop, in the same `onData` callback that forwards `TERMINAL_DATA`. ~6000 sync syscalls/sec under a flood.
- **Fixed:** rewrote `terminalLogger.ts` to use one kept-open `fs.createWriteStream(path, { flags: 'a' })` per logger, with an in-memory buffer flushed on a ~250ms timer (or a 1MB safety cap) — ~4 `stream.write()`/sec under a flood, no `*Sync` on the hot path. Bytes-written tracked in memory (no per-flush `statSync`); rotation at 1MB ends+renames the stream and reopens. Shutdown/read paths drain the pending buffer with a synchronous `appendFileSync` (a stream's buffer can't be sync-drained at exit) so no scrollback is lost on quit; stream errors fall back to sync append. Result: ~10% better CPU-per-byte and the event loop no longer blocks on disk.

### 3. Process-tree poll every 1s regardless of focus
`src/main/ipc/shell.ts:357-396, 453-458`
- **Wrong:** `runActivityScan()` runs on `setInterval(1000)` and never checks `anyWindowFocused`; per terminal it spawns `pgrep -P <pid>` then `ps -o comm= -p <pid>` per child, indefinitely, even backgrounded.
- **Fix:** Back off cadence when unfocused (e.g. 1s focused, 5–10s unfocused) rather than disabling — the scan drives "needs input"/"finished" notifications that matter while backgrounded. `installFocusHooks` already maintains `anyWindowFocused`.

### 4. Smooth zoom re-renders every CanvasNode — ✅ FIXED
`src/renderer/panels/CanvasPanel.tsx`; `CanvasNode.tsx`; `useCanvasNodeStyle.ts`; `useNodeResize.ts`
- **Was:** every zoom frame wrote a new `zoomLevel` that flowed as a prop into every `CanvasNodeWrapper`/`CanvasNode` (in the memo comparator), re-rendering all visible nodes every frame even though node DOM positions come from the imperative world transform (`Canvas.tsx`). 374 CanvasNode renders/s measured.
- **Fixed:** removed the reactive `zoomLevel` prop from the whole CanvasNode chrome path. `useCanvasNodeStyle` never read it (removed param + dep); `useNodeResize` now reads zoom lazily via `canvasStoreApi.getState().zoomLevel`; `CanvasNodeWrapper.renderPanel` reads zoom lazily so its identity is stable across frames; `BrowserPanel`'s dead `zoomLevel` prop removed. `TerminalPanel` (the only real zoom consumer, for render-scale crispness) already subscribes to zoom from the store context, so it re-renders only itself. Result: **374 → 3** CanvasNode renders/s on zoom.

### 5. `useVisibleNodeIds` re-sorts all nodes per emission
`src/renderer/stores/canvasStore.ts:1416-1466`
- **Wrong:** Selector runs `Object.values(nodes).sort(...)` + full cull on every emission; the equality fn only gates the React re-render, not the allocate+sort.
- **Fix:** Memoize the sorted-id array keyed on the `nodes` reference (a `WeakMap<nodes, sortedIds>`); run only the cheap O(n) cull each frame.

### 6. Region drag/resize unthrottled
`src/renderer/canvas/CanvasRegionComponent.tsx:90-137, 305-334`; `canvasStore.ts:1034-1056`
- **Fix:** Mirror `useNodeResize.ts:353-370` — accumulate latest geometry in a ref, apply once per rAF, flush on mouseup.

### 7. Right-click pan unthrottled
`src/renderer/hooks/useCanvasInteraction.ts:435-469`
- **Fix:** Accumulate dx/dy in a ref, flush a single `setViewportOffset` in rAF — copy the existing wheel-pan pattern (`:292-304`).

### 8. Auto-scroll forces synchronous layout per token
`src/agent/renderer/ChatThread.tsx:84-91`
- **Wrong:** Effect deps `[messages.length, last]`; `last` is a new object per delta, so it reads `scrollHeight`/`scrollTop`/`clientHeight` (forced reflow) every token.
- **Fix:** Track a `stickToBottom` boolean from scroll events; only `scrollTo` when sticky, rAF-coalesced.

### 9. Unbounded transcript + quadratic concat
`src/agent/renderer/agentStore.ts:358-443`
- **Fix:** Keep the immutable array copy (cheap — N = message count), but cap retained tool `result`/`partialText` length or store large bodies lazily. The per-message `cur.text + delta` concat is the O(n²) target.

### 10. No virtualization for long message lists
`src/agent/renderer/ChatThread.tsx:114-153`
- **Fix:** List virtualization keyed on message id, rendering only on-screen rows + streaming tail. At minimum #1's `React.memo` covers most of the win cheaply.

### 11. Git monitor: 3 spawns per poll, fs-watch pins 2s floor
`src/main/ipc/git-monitor.ts:106-122, 262-274`
- **Fix:** One `git status --porcelain=v2 --branch` for branch + dirty; run `for-each-ref` on a slower cadence; time-debounce the fs-watch kick so multi-file saves don't re-arm the 2s floor.

### 12. `GIT_WORKTREE_STATUS` per-worktree fan-out
`src/main/ipc/git.ts:448-488`; caller `ParallelWorkTab.tsx:437-447`
- **Fix:** `git status --porcelain -uno` (skip untracked walk); derive ahead/behind from a single `porcelain=v2 --branch`; cache/dedup so frequent dirty toggles don't re-fan-out.

### 13. `FS_SEARCH` full-file reads, no budget
`src/main/ipc/filesystem.ts:168-280, 709-719`
- **Fix:** Global bytes-scanned/time budget + max-files cap; read in chunks and bail on first match; prefer `ripgrep` when available.

### 14. WebGL recreate on every visibility re-attach
`src/renderer/lib/terminalRegistry.ts:979-996`; `TerminalPanel.tsx:308-325`
- **Fix:** Track `lastContainer` on the entry; only recreate WebGL when the element actually moved to a different container.

### 15. URL auto-open scans every chunk
`src/renderer/lib/terminalUrlAutoOpen.ts:135-200`
- **Fix:** Cheap `indexOf` pre-filter (skip ANSI strip when no `:`/`http`); cap the strip to a tail slice; reuse a scratch buffer.

### 16. No large-file guard in EditorPanel
`src/renderer/panels/EditorPanel.tsx:539-609`; `filesystem.ts:82-83`
- **Fix:** Above a size/line threshold set language to `plaintext`, disable `wordWrap`, skip language services / open read-only. Add a byte check in `FS_READ_FILE`.

### 17. Monaco LRU keeps 20 closed models
`src/renderer/panels/EditorPanel.tsx:118-160`
- **Fix:** Byte-budget cap (not just entry count); dispose on release above a size threshold or schedule idle disposal.

### 18. Body-spinner regex per chunk
`src/renderer/lib/terminalRegistry.ts:534,725`; `agentSpinner.ts:39-41`
- **Fix:** Gate behind the per-terminal agent-presence flag, or a cheap `indexOf` pre-check before the allocating `replace`.

### 19. EditorPanel subscribes to whole `workspaces`
`src/renderer/panels/EditorPanel.tsx:371-374`
- **Fix:** Narrow to primitives: `useAppStore((s) => s.workspaces.find(w => w.id === workspaceId)?.rootPath)` and the analogous `diffMode`.

### 20. CanvasRegionComponent re-parses color ~20×/render
`src/renderer/canvas/CanvasRegionComponent.tsx:361-372`
- **Fix:** `const rgb = useMemo(() => parseRgba(region.color), [region.color])` once, reused across all channels.

---

## Recommended order of attack

**Phase 1 — quick wins (S, low risk):** #2, #3, #6, #7, #8, then the trivial
cleanups #20/#18/#19/#15/#14, then #11.

**Phase 2 — the two compounding hotspots (M):** #1 (also largely fixes #10 and
relieves #9), #4, #5, #12.

**Phase 3 — structural (M/L):** #9, #13, #10 (true virtualization, only if
profiling still shows it after #1), #17.

Wire the profiling layer in alongside Phase 1 so every change has before/after
numbers.

---

## Profiling layer (`CATE_PERF=1`)

Implemented and gated entirely behind the env flag (mirrors `CATE_E2E`), so it
is zero-cost on normal launches.

**Main process** — `src/main/perf/perfMonitor.ts`
- `app.getAppMetrics()` sampler every 2s → per-process CPU% + working-set MB,
  tagged focused/backgrounded; logged as a one-line `[perf]` entry and exposed
  to the renderer via the `perf:get` IPC.
- Counters instrumented at the audited hot paths:
  - subprocess spawns — `pgrep`/`ps`/`lsof` in `shell.ts`, `git` in `git-monitor.ts`
    (quantifies #3/#11)
  - main→renderer IPC bytes per channel — `windowRegistry.sendToWindow`/`broadcastToAll`
    (surfaces `TERMINAL_DATA` volume and broadcast rate)
  - terminal PTY throughput — `terminal.ts` `onData` (quantifies #2/#15)

**Renderer** — `src/renderer/lib/perf/perfClient.ts` + `src/renderer/ui/PerfHud.tsx`
- `useRenderCount(name)` probes on `CanvasNode`, `CanvasPanel`, `ChatThread`,
  `MessageRow`, `EditorPanel` → renders/sec (the before/after signal for the
  memoization fixes #1/#4/#19).
- `PerformanceObserver({entryTypes:['longtask']})` → main-thread tasks >50ms.
- rAF FPS meter.
- `PerfHud` overlay (toggle ⌘⌥P) renders all of the above live.

### E2E stress test

`e2e/perf-stress.spec.ts` drives the app under load with the profiler active
(`launchApp({ perf: true })` → `CATE_PERF=1`) and prints a per-scenario report
(FPS, long tasks, renders/s, main CPU, terminal throughput,
spawns). Run it with:

```bash
npm run build && npx playwright test e2e/perf-stress.spec.ts
```

Scenarios: idle baseline, canvas pan (wheel), canvas zoom (deterministic
`setZoom` cascade), and a real terminal flood (`yes | head -n 4M`). Assertions
are generous guardrails (no multi-second freeze, pan/zoom stay >20fps, the flood
actually floods) — the value is the printed numbers.

**Measured on a dev MacBook (≈6 nodes, fast machine), before vs after the
#4 + #2 fixes:**

| Scenario | CanvasNode renders/s | main-proc CPU | terminal |
|---|---|---|---|
| idle | 0 | ~0% | 0 |
| canvas pan | 6 | ~0.5% (main) | — |
| **canvas zoom** | **374 → 3** ✅ | ~0.4% (main) | — |
| **terminal flood** | 6 | **9.2% @ 19.7MB/s (sync) → ~10% @ 24MB/s (stream)** ✅ | 22 MB/s, ~50k chunks/s |

Takeaways: **pan is cheap** (the wheel path is rAF-batched; `useVisibleNodeIds`
sort #5 is not hot at this node count). **Zoom was the real canvas hotspot** —
every zoom frame re-rendered *every* node (#4); 374 renders/s at ~6 nodes,
scaling linearly with node count. **Fixed** (see #4 below): now 3/s. The
**terminal flood** drives ~50k PTY data callbacks/sec; the old logger did a
synchronous `statSync`+`appendFileSync` per 4KB on that path (~6000 sync
syscalls/sec, blocking the event loop). **Fixed** (see #2): a kept-open append
write-stream batched on a 250ms timer — ~4 disk writes/sec, no main-thread
blocking, and ~10% better CPU-per-byte.

**Not yet measured** (add when working the relevant fix): Monaco model-cache
gauge (#17), `FS_SEARCH`/`GIT_WORKTREE_STATUS` round-trip timing (#12/#13, these
go through `ipcMain.handle` rather than the `sendToWindow` tap), per-selector
cost timer for `useVisibleNodeIds` (#5), and simple-git spawns in `git.ts` (only
`git-monitor.ts`'s `execFile` git is counted today).
