# Canvas Polish — Design Spec

**Date:** 2026-03-28
**Goal:** Make CanvasIDE's canvas feel as smooth and responsive as Figma — buttery interactions, snappy animations, zero jank.

## Context

CanvasIDE is a spatial coding canvas where users run multiple Claude Code terminal sessions simultaneously. The canvas is the primary interaction surface — pan, zoom, drag, resize, create, close panels — and it needs to feel effortless. Currently, interactions feel clunky: zoom is stepped, panning stops dead, state changes snap without transition, and broad store subscriptions cause unnecessary re-renders. This spec defines a "Canvas Polish" phase to fix all of this before layering on new features.

## Design

### 1. Performance Foundation

Eliminate rendering jank. Without this, animations make things worse.

#### 1.1 Memoize sortedNodes
- **File:** `src/renderer/App.tsx`
- `Object.values(nodes).sort(...)` recomputes on every render (zoom, offset, focus changes)
- Wrap in `useMemo` keyed on `nodes`

#### 1.2 Granular store selectors
- **Files:** `src/renderer/App.tsx`, `src/renderer/stores/canvasStore.ts`
- `useCanvasStore((s) => s.nodes)` subscribes to the entire nodes object — any node move re-renders all nodes
- Add `useNodeIds()` selector that returns a stable sorted ID array using a custom equality function (compare length + each element), NOT Zustand `shallow` (which fails on fresh tuple arrays)
- App.tsx subscribes to `useNodeIds()`, passes `nodeId` + `zoomLevel` as props to each CanvasNode
- **Important:** `zoomLevel` must remain a prop from App.tsx (not self-subscribed per-node), because zoom changes need to update all visible nodes for shadow/size calculations. The optimization target is eliminating re-renders from *other node* position/size changes, not from zoom.
- CanvasNode self-subscribes to its own node data (`nodes[nodeId]`) and `focusedNodeId`

#### 1.3 requestAnimationFrame batching for drag/resize
- **Files:** `src/renderer/hooks/useNodeDrag.ts`, `src/renderer/hooks/useNodeResize.ts`
- Accumulate mouse position in a ref, batch store updates via RAF (max 1 update/frame)
- Move `snapToEdges` into the RAF callback
- Pattern: `pendingPos` ref + single active RAF id + cancel on unmount

#### 1.4 Viewport culling
- **Files:** `src/renderer/App.tsx`, `src/renderer/lib/coordinates.ts`
- Add `isNodeVisible(node, viewport, margin)` helper — check intersection with 200px buffer
- Filter rendered nodes to visible-only
- **Terminal culling signal:** Check `shellActivityMap` from statusStore — terminals with `activity.type === 'running'` or `claudeState !== 'notRunning'` must never be unmounted. Idle terminals can be safely culled (PTY stays alive in registry, xterm DOM unmounts)
- Phase 1: Cull editor and browser panels only (no lifecycle concerns). Phase 2: Extend to idle terminals

#### 1.5 Stable wheel event listener
- **File:** `src/renderer/canvas/Canvas.tsx`
- Use ref pattern to attach wheel listener once on mount, avoiding re-attachment on re-renders
- Minor fix — the listener already exists with proper cleanup, just needs a `handleWheelRef` pattern to avoid dependency churn

#### 1.6 GPU compositing hints
- **Files:** `src/renderer/canvas/Canvas.tsx`, `src/renderer/canvas/CanvasNode.tsx`
- Add `will-change: transform` to the canvas world div (always active — it transforms on every pan/zoom)
- Add `will-change: transform` to CanvasNode containers on drag start, remove on drag end (promotes to own compositor layer during drag, avoids permanent GPU memory overhead)

#### 1.7 Pointer-events blocker during interactions
- **Files:** `src/renderer/canvas/Canvas.tsx`, `src/renderer/canvas/CanvasNode.tsx`
- During canvas pan or node drag, overlay a transparent `pointer-events: all` div over panel content (iframes, Monaco editors, xterm) to prevent mouse events leaking into embedded content
- Without this, dragging near a BrowserPanel webview or Monaco editor feels broken as events get swallowed

#### 1.8 Cursor feedback during pan
- **File:** `src/renderer/hooks/useCanvasInteraction.ts`
- Set `cursor: grabbing` on the canvas during right-click drag pan
- Set `cursor: grab` on hover when no interaction is active (optional, can be subtle)

### 2. Smooth Canvas Interactions

#### 2.1 Momentum panning (right-click drag + trackpad)
- **File:** `src/renderer/hooks/useCanvasInteraction.ts`
- **Right-click drag:** Track velocity over last 3-5 frames. On mouseup, start RAF inertia loop with exponential decay (`velocity *= 0.95`), stop below 0.5px/frame. Cancel on any new interaction.
- **Trackpad pan:** The current `handleWheel` calls `e.preventDefault()` on all wheel events, which **kills native macOS trackpad momentum**. Fix: only call `preventDefault()` when `e.ctrlKey` is true (zoom gesture). For non-zoom wheel events (pan), let the OS provide momentum naturally, OR implement JS-side momentum tracking for wheel events too. Recommendation: stop preventing default for pan events — native momentum feels better than anything we can replicate.

#### 2.2 Smooth zoom with easing
- **File:** `src/renderer/hooks/useCanvasInteraction.ts`, `src/renderer/stores/canvasStore.ts`
- Accumulate "target zoom" in a ref — each wheel event updates target
- RAF loop interpolates: `current += (target - current) * lerp` where `lerp` is frame-rate-independent: `1 - Math.pow(0.001, deltaTime / 160)` (equivalent to 0.15 at 60fps, adapts to 120Hz)
- **Critical:** Batch `zoomLevel` and `viewportOffset` into a single `set()` call per frame. Separate calls cause two re-renders per frame, producing visible flicker (zoom changes without matching offset for one frame). Add a `setZoomAndOffset(zoom, offset)` action to canvasStore.
- Recalculate viewport offset each frame to keep cursor point stable in canvas-space
- Stop when `|current - target| < 0.001`

#### 2.3 Verify pinch-to-zoom coverage
- **File:** `src/renderer/hooks/useCanvasInteraction.ts`
- In Electron's Chromium, trackpad pinch-to-zoom is delivered as `wheel` events with `e.ctrlKey === true` (synthesized). The current code already handles `e.ctrlKey` at line 63. **Do NOT add separate `GestureEvent`/`TouchEvent` listeners** — this would cause double-zoom.
- Verify the existing `ctrlKey` path works correctly with the new smooth zoom system from 2.2. The pinch wheel events should feed into the same target-zoom accumulator.

#### 2.4 Toolbar zoom animation
- **Files:** `src/renderer/App.tsx`, `src/renderer/canvas/CanvasToolbar.tsx`
- Zoom +/- buttons animate to target via smooth zoom system
- Zoom percentage text becomes clickable — animates back to 100%

#### 2.5 Animation utilities
- **New file:** `src/renderer/lib/animation.ts`
- `inertiaLoop(velocity, applyFn, decay, threshold)` — generic momentum helper
- `springAnimation(from, to, stiffness, damping, onUpdate, onComplete)` — spring helper

### 3. Animation System

Short, snappy animations (150-300ms). CSS transitions, not JS animation loops.

#### 3.1 Panel creation animation
- **Files:** `src/renderer/canvas/CanvasNode.tsx`, `src/renderer/stores/canvasStore.ts`
- Add `animationState: 'entering' | 'exiting' | 'idle'` to `CanvasNodeState`, default `'entering'`
- Entering: start `scale(0.85) opacity(0)`, transition to `scale(1) opacity(1)` over 200ms
- Easing: `cubic-bezier(0.34, 1.56, 0.64, 1)` (subtle overshoot bounce)
- Set to `'idle'` on `transitionend` with a fallback `setTimeout(250ms)` in case `transitionend` doesn't fire (backgrounded tab, interrupted transition, display:none)

#### 3.2 Panel removal animation
- **Files:** `src/renderer/canvas/CanvasNode.tsx`, `src/renderer/stores/canvasStore.ts`
- On remove: set `animationState` to `'exiting'` instead of deleting immediately
- Exiting: `scale(0.9) opacity(0)` over 180ms with `ease-in`, `pointerEvents: none`
- Actually remove from store on `transitionend` via `finalizeRemoveNode` action, with fallback `setTimeout(200ms)` for reliability
- **Workspace restore:** When `loadWorkspaceCanvas` restores nodes, set `animationState` to `'idle'` (not `'entering'`) — restored nodes should not animate in

#### 3.3 Focus change transitions
- **File:** `src/renderer/canvas/CanvasNode.tsx`
- Add CSS transitions: `border-color 150ms ease, box-shadow 200ms ease`
- Always render unfocus overlay, toggle via `opacity` (not conditional mount) for smooth fade

#### 3.4 Maximize/restore animation
- **Files:** `src/renderer/canvas/CanvasNode.tsx`, `src/renderer/stores/canvasStore.ts`
- Animate position + size over 250ms: `cubic-bezier(0.16, 1, 0.3, 1)`
- Disable transitions during drag/resize to prevent interference

### 4. Smart Snapping & Alignment

#### 4.1 Real-time magnetic snapping
- **Files:** `src/renderer/hooks/useNodeDrag.ts`, `src/renderer/canvas/layoutEngine.ts`
- During drag (in RAF callback): run `snapToEdges`, if within 4px lock to snap, 4-8px interpolate (magnetic pull)
- Replaces current mouseup-only snap behavior

#### 4.2 Enhanced snap guides
- **Files:** `src/renderer/canvas/SnapGuides.tsx`, `src/renderer/stores/canvasStore.ts`, `src/renderer/canvas/layoutEngine.ts`
- Expand snap guides type: `{ lines: Array<{ axis, position, type }> }` — supports multiple simultaneous lines
- Add center-to-center alignment detection (midpoints)
- Render: edge lines solid, center lines dashed, distance labels between aligned edges

#### 4.3 Equal spacing guides
- **Files:** `src/renderer/canvas/layoutEngine.ts`, `src/renderer/canvas/SnapGuides.tsx`
- Detect equal gaps between 3+ nodes in a row/column:
  - "In a row": nodes whose vertical center-lines are within 20px tolerance, sorted by X position
  - "In a column": nodes whose horizontal center-lines are within 20px tolerance, sorted by Y position
  - For each axis: compute gaps between consecutive node edges. If dragged node position would create a gap matching an existing gap (within snap threshold), snap to it
- Show spacing guides (magenta, Figma-style) with distance labels and snap to equal-spacing position

### 5. Visual Polish & Gestures

#### 5.1 Zoom-responsive shadows
- **File:** `src/renderer/canvas/CanvasNode.tsx`
- Scale shadow blur/spread based on zoom: minimal at low zoom, proportional at high zoom
- Shadow appears constant screen-size regardless of canvas zoom

#### 5.2 Visible resize handles
- **File:** `src/renderer/canvas/CanvasNode.tsx`
- 4 corner handles (8x8px rounded squares, `bg-white/20 border-white/40`)
- `opacity: 0` default, `opacity: 1` on node hover, 150ms fade transition

#### 5.3 Drag dead zone
- **File:** `src/renderer/hooks/useNodeDrag.ts`
- 4px dead zone before drag starts — prevents accidental micro-drags on title bar clicks
- Same pattern as existing `RIGHT_CLICK_DRAG_THRESHOLD`

## Implementation Order

**Phase 1 — Quick wins (no dependencies):**
- 1.1 Memoize sortedNodes
- 1.5 Stable wheel listener
- 1.6 GPU compositing hints
- 1.8 Cursor feedback during pan
- 3.3 Focus change transitions
- 5.1 Zoom-responsive shadows
- 5.2 Visible resize handles
- 5.3 Drag dead zone

**Phase 2 — Performance core:**
- 1.2 Granular store selectors
- 1.3 RAF batching for drag/resize
- 1.7 Pointer-events blocker during interactions
- 1.4 Viewport culling (editor/browser panels only — no terminal lifecycle concerns)

**Phase 3 — Smooth interactions (zoom first — highest impact):**
- 2.5 Animation utilities (animation.ts)
- 2.2 Smooth zoom with easing
- 2.3 Verify pinch-to-zoom coverage
- 2.1 Momentum panning (right-click drag + trackpad fix)
- 2.4 Toolbar zoom animation

**Phase 4 — Animations:**
- 3.1 Panel creation animation
- 3.2 Panel removal animation
- 3.4 Maximize/restore animation

**Phase 5 — Smart snapping:**
- 4.1 Real-time magnetic snapping
- 4.2 Enhanced snap guides
- 4.3 Equal spacing guides

**Phase 6 — Extended culling:**
- 1.4 (extended) Viewport culling for idle terminals

## Critical Files

| File | Changes |
|------|---------|
| `src/renderer/hooks/useCanvasInteraction.ts` | Momentum pan, smooth zoom, pinch-to-zoom verify, cursor feedback |
| `src/renderer/canvas/CanvasNode.tsx` | All visual polish — shadows, transitions, handles, enter/exit animations |
| `src/renderer/hooks/useNodeDrag.ts` | RAF batching, dead zone, real-time snapping |
| `src/renderer/App.tsx` | Memoization, granular selectors, viewport culling |
| `src/renderer/stores/canvasStore.ts` | animationState field, expanded snap guides, nodeIds selector, setZoomAndOffset action |
| `src/renderer/canvas/layoutEngine.ts` | Enhanced snapping algorithms |
| `src/renderer/canvas/SnapGuides.tsx` | Multiple guide lines, center alignment, spacing guides |
| `src/renderer/canvas/CanvasToolbar.tsx` | Clickable zoom percentage |
| `src/renderer/lib/animation.ts` | New — inertia and spring animation utilities |
| `src/renderer/lib/coordinates.ts` | isNodeVisible helper for viewport culling |

## Verification

1. **Performance:** Open 10+ terminal panels. Drag one — should feel instant with no stutter. Verify via React DevTools Profiler that only the dragged node re-renders.
2. **Smooth zoom:** Scroll wheel on the canvas. Zoom should ease in/out smoothly, never stepping. Cursor point should remain stable (same canvas-space position stays under cursor).
3. **Momentum:** Right-click drag and release quickly. Canvas should coast and decelerate smoothly.
4. **Animations:** Create a panel — should scale up with subtle bounce. Close it — should scale down and fade. Toggle focus between panels — borders should transition smoothly.
5. **Snapping:** Drag a panel near another. Should magnetically snap to aligned edges with visible guide lines. Drag between two panels — should show equal spacing guides.
6. **Resize handles:** Hover over a panel corner — handle dots should fade in. Drag to resize.
7. **Dead zone:** Click a title bar button — should not accidentally start a drag.
8. **Viewport culling:** Zoom out to see all panels, then zoom into one area. Panels far off-screen should unmount (verify via React DevTools). Active terminals should remain mounted.
