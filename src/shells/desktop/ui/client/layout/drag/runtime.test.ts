import { describe, it, expect } from 'vitest'
import { reduce, initial } from './runtime'
import type {
  DragEffect,
  DragEvent,
  DragSource,
  DropTarget,
  RuntimeState,
} from './types'
import { INITIAL_RUNTIME_STATE } from './types'
import type { CrossWindowDrag } from './ports'

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const canvasNodeSource: DragSource = {
  workspaceId: 'ws',
  panelId: 'panel-1',
  origin: { kind: 'canvas-node', canvasId: 'c1', nodeId: 'node-1' },
}

const dockTabSource: DragSource = {
  workspaceId: 'ws',
  panelId: 'panel-1',
  origin: { kind: 'dock-tab', dock: { windowId: 'main' }, stackId: 'stack-1' },
}

const panel = { id: 'panel-1', type: 'editor', title: 'Test' }
const grab = { x: 10, y: 5 }
const ghostSize = { width: 320, height: 200 }
const cursor = { x: 100, y: 80 }

function snapshot(): CrossWindowDrag {
  return { dragId: 'd1', workspaceId: 'ws', panelId: 'panel-1', panelType: 'editor', title: 'Test', size: ghostSize, grab }
}

const reposition: DropTarget = {
  kind: 'canvas-reposition',
  workspaceId: 'ws',
  canvasId: 'c1',
  nodeId: 'node-1',
  origin: { x: 0, y: 0 },
  zoom: 1,
}

function startEvent(source: DragSource = canvasNodeSource): DragEvent {
  return { type: 'START', source, panel, grab, ghostSize, ghostZoom: 1, cursor }
}

function effectKinds(effects: readonly DragEffect[]): string[] {
  return effects.map(e => e.kind).sort()
}

function hasEffect<K extends DragEffect['kind']>(
  effects: readonly DragEffect[],
  kind: K,
): Extract<DragEffect, { kind: K }> | undefined {
  return effects.find(e => e.kind === kind) as Extract<DragEffect, { kind: K }> | undefined
}

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------

describe('reduce(START)', () => {
  it('populates state from a canvas-node source and emits the start effect', () => {
    const next = reduce(INITIAL_RUNTIME_STATE, startEvent(canvasNodeSource))
    expect(next.armed).toBe(true)
    expect(next.state.isDragging).toBe(true)
    expect(next.state.source).toEqual(canvasNodeSource)
    expect(next.state.panel).toEqual(panel)
    expect(next.state.grab).toEqual(grab)
    expect(next.state.ghostSize).toEqual(ghostSize)
    expect(next.state.cursor).toEqual({
      client: cursor,
      screen: cursor,
      insideWindow: true,
    })
    expect(next.state.target).toBeNull()
    expect(next.state.crossWindow).toBeNull()

    expect(effectKinds(next.effects)).toEqual(['set-body-class'])
    const bodyCls = hasEffect(next.effects, 'set-body-class')
    expect(bodyCls?.on).toBe(true)
    expect(bodyCls?.cls).toBe('canvas-interacting')
  })

  it('a dock-tab source starts the same way', () => {
    const next = reduce(INITIAL_RUNTIME_STATE, startEvent(dockTabSource))
    expect(next.armed).toBe(true)
    expect(next.state.source).toEqual(dockTabSource)
    expect(effectKinds(next.effects)).toEqual(['set-body-class'])
  })
})

// -----------------------------------------------------------------------------
// MOVE
// -----------------------------------------------------------------------------

describe('reduce(MOVE)', () => {
  const armed = reduce(INITIAL_RUNTIME_STATE, startEvent(canvasNodeSource))

  it('updates cursor when moving inside the window', () => {
    const next = reduce(armed, {
      type: 'MOVE',
      client: { x: 200, y: 150 },
      screen: { x: 200, y: 150 },
      insideWindow: true,
    })
    expect(next.state.cursor).toEqual({
      client: { x: 200, y: 150 },
      screen: { x: 200, y: 150 },
      insideWindow: true,
    })
    expect(next.crossWindowActive).toBe(false)
    expect(next.effects).toEqual([])
  })

  it('emits cross-window-start when leaving the window with a cross-window drag', () => {
    const snap = snapshot()
    const next = reduce(armed, {
      type: 'MOVE',
      client: { x: -10, y: -10 },
      screen: { x: -10, y: -10 },
      insideWindow: false,
      crossWindow: snap,
    })
    expect(next.crossWindowActive).toBe(true)
    expect(next.state.crossWindow).toEqual(snap)
    const e = hasEffect(next.effects, 'cross-window-start')
    expect(e).toBeDefined()
    expect(e?.drag).toEqual(snap)
    expect(e?.screen).toEqual({ x: -10, y: -10 })
  })

  it('does not re-emit cross-window-start on a second outside MOVE', () => {
    const snap = snapshot()
    const outside1 = reduce(armed, {
      type: 'MOVE',
      client: { x: -10, y: -10 },
      screen: { x: -10, y: -10 },
      insideWindow: false,
      crossWindow: snap,
    })
    const outside2 = reduce(outside1, {
      type: 'MOVE',
      client: { x: -20, y: -20 },
      screen: { x: -20, y: -20 },
      insideWindow: false,
      crossWindow: snap,
    })
    expect(hasEffect(outside2.effects, 'cross-window-start')).toBeUndefined()
    expect(outside2.crossWindowActive).toBe(true)
  })

  it('emits cross-window-cancel when transitioning outside→inside while active', () => {
    const snap = snapshot()
    const outside = reduce(armed, {
      type: 'MOVE',
      client: { x: -10, y: -10 },
      screen: { x: -10, y: -10 },
      insideWindow: false,
      crossWindow: snap,
    })
    const back = reduce(outside, {
      type: 'MOVE',
      client: { x: 50, y: 50 },
      screen: { x: 50, y: 50 },
      insideWindow: true,
    })
    expect(hasEffect(back.effects, 'cross-window-cancel')).toBeDefined()
    expect(back.crossWindowActive).toBe(false)
    expect(back.state.crossWindow).toBeNull()
  })

  it('does not emit cross-window-start without a cross-window drag', () => {
    const next = reduce(armed, {
      type: 'MOVE',
      client: { x: -10, y: -10 },
      screen: { x: -10, y: -10 },
      insideWindow: false,
    })
    expect(hasEffect(next.effects, 'cross-window-start')).toBeUndefined()
    expect(next.crossWindowActive).toBe(false)
  })

  it('is a no-op when not armed', () => {
    const result = reduce(INITIAL_RUNTIME_STATE, {
      type: 'MOVE',
      client: { x: 0, y: 0 },
      screen: { x: 0, y: 0 },
      insideWindow: true,
    })
    expect(result.effects).toEqual([])
    expect(result.state).toBe(INITIAL_RUNTIME_STATE.state)
  })
})

// -----------------------------------------------------------------------------
// TARGET
// -----------------------------------------------------------------------------

describe('reduce(TARGET)', () => {
  const armed = reduce(INITIAL_RUNTIME_STATE, startEvent(canvasNodeSource))

  it('stores the target without emitting effects', () => {
    const target = reposition
    const next = reduce(armed, { type: 'TARGET', target })
    expect(next.state.target).toEqual(target)
    expect(next.effects).toEqual([])
    // Cursor preserved.
    expect(next.state.cursor).toEqual(armed.state.cursor)
  })

  it('accepts null to clear the target', () => {
    const target = reposition
    const withTarget = reduce(armed, { type: 'TARGET', target })
    const cleared = reduce(withTarget, { type: 'TARGET', target: null })
    expect(cleared.state.target).toBeNull()
    expect(cleared.effects).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// END
// -----------------------------------------------------------------------------

describe('reduce(END)', () => {
  const armed = reduce(INITIAL_RUNTIME_STATE, startEvent(canvasNodeSource))

  it('emits commit + cleanup effects when a target is set', () => {
    const target = reposition
    const withTarget = reduce(armed, { type: 'TARGET', target })
    const ended = reduce(withTarget, { type: 'END' })

    const commit = hasEffect(ended.effects, 'commit')
    expect(commit).toBeDefined()
    expect(commit?.source).toEqual(canvasNodeSource)
    expect(commit?.target).toEqual(target)
    expect(commit?.panel).toEqual(panel)

    expect(hasEffect(ended.effects, 'set-body-class')?.on).toBe(false)

    // State reset.
    expect(ended.armed).toBe(false)
    expect(ended.state.isDragging).toBe(false)
    expect(ended.state.source).toBeNull()
    expect(ended.state.target).toBeNull()
  })

  it('emits only cleanup when no target is set', () => {
    const ended = reduce(armed, { type: 'END' })
    expect(hasEffect(ended.effects, 'commit')).toBeUndefined()
    expect(hasEffect(ended.effects, 'set-body-class')?.on).toBe(false)
  })

  it('emits cross-window-cancel when cross-window-active and no target', () => {
    const snap = snapshot()
    const outside = reduce(armed, {
      type: 'MOVE',
      client: { x: -10, y: -10 },
      screen: { x: -10, y: -10 },
      insideWindow: false,
      crossWindow: snap,
    })
    const ended = reduce(outside, { type: 'END' })
    expect(hasEffect(ended.effects, 'cross-window-cancel')).toBeDefined()
    expect(hasEffect(ended.effects, 'commit')).toBeUndefined()
  })

  it('is idempotent after a prior END (MOVE after END = no effects)', () => {
    const ended = reduce(armed, { type: 'END' })
    const moveAfter = reduce(ended, {
      type: 'MOVE',
      client: { x: 10, y: 10 },
      screen: { x: 10, y: 10 },
      insideWindow: true,
    })
    expect(moveAfter.effects).toEqual([])
    // Second END on a teardown state shouldn't fire commit effects again.
    const endAgain = reduce(ended, { type: 'END' })
    expect(hasEffect(endAgain.effects, 'commit')).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// CANCEL
// -----------------------------------------------------------------------------

describe('reduce(CANCEL)', () => {
  const armed = reduce(INITIAL_RUNTIME_STATE, startEvent(canvasNodeSource))

  it('emits cleanup but NEVER commit, even with a target', () => {
    const target = reposition
    const withTarget = reduce(armed, { type: 'TARGET', target })
    const cancelled = reduce(withTarget, { type: 'CANCEL' })
    expect(hasEffect(cancelled.effects, 'commit')).toBeUndefined()
    expect(hasEffect(cancelled.effects, 'set-body-class')?.on).toBe(false)
    expect(cancelled.armed).toBe(false)
    expect(cancelled.state.isDragging).toBe(false)
  })

  it('emits cross-window-cancel when cross-window-active', () => {
    const snap = snapshot()
    const outside = reduce(armed, {
      type: 'MOVE',
      client: { x: -10, y: -10 },
      screen: { x: -10, y: -10 },
      insideWindow: false,
      crossWindow: snap,
    })
    const cancelled = reduce(outside, { type: 'CANCEL' })
    expect(hasEffect(cancelled.effects, 'cross-window-cancel')).toBeDefined()
  })

  it('after CANCEL, END is a no-op (no commit, no source-attr toggling)', () => {
    const cancelled = reduce(armed, { type: 'CANCEL' })
    const endAfter = reduce(cancelled, { type: 'END' })
    expect(hasEffect(endAfter.effects, 'commit')).toBeUndefined()
  })
})

// Sanity: the `initial` export is the INITIAL_RUNTIME_STATE.
describe('initial', () => {
  it('matches INITIAL_RUNTIME_STATE', () => {
    expect(initial).toBe(INITIAL_RUNTIME_STATE)
  })
})

// Type-only assertion: keep RuntimeState shape stable.
const _typeCheck: RuntimeState = INITIAL_RUNTIME_STATE
void _typeCheck
