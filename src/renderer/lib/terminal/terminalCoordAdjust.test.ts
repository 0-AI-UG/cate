import { describe, it, expect } from 'vitest'
import { shouldAdjustTerminalCoords } from './terminalCoordAdjust'

// Mouse buttons per the DOM spec.
const LEFT = 0
const MIDDLE = 1
const RIGHT = 2

// A zoomed-in canvas: .xterm-screen carries a residual scale of 2, so xterm's
// getBoundingClientRect()-based hit-testing is off by 2x and needs adjusting for
// its OWN (left-button) selection.
const ZOOMED = 2

describe('shouldAdjustTerminalCoords', () => {
  it('adjusts a left-button press on a zoomed canvas (xterm selection needs it)', () => {
    expect(shouldAdjustTerminalCoords('mousedown', LEFT, false, ZOOMED)).toBe(true)
  })

  it('adjusts left-button moves on a zoomed canvas (drag-select)', () => {
    expect(shouldAdjustTerminalCoords('mousemove', LEFT, false, ZOOMED)).toBe(true)
  })

  // --- The middle-click-pan regression guard -------------------------------
  // Middle/right press starts a canvas pan, not an xterm selection. The pan's
  // opening mousedown MUST be left raw: it is recorded as the pan's origin
  // (lastPanPos) while every follow-up move stays raw, so rewriting it would
  // make the first pan delta (raw - adjusted) and jump the camera. This is the
  // guard that, when removed, reintroduces the "middle-click drag offsets the
  // pan at the beginning" bug.
  it('does NOT adjust a middle-button press on a zoomed canvas (pan start)', () => {
    expect(shouldAdjustTerminalCoords('mousedown', MIDDLE, false, ZOOMED)).toBe(false)
  })

  it('does NOT adjust a right-button press on a zoomed canvas (pan start)', () => {
    expect(shouldAdjustTerminalCoords('mousedown', RIGHT, false, ZOOMED)).toBe(false)
  })

  it('never adjusts while a canvas gesture owns the pointer (canvas-interacting)', () => {
    // Every event type stays raw once a pan/resize holds the body class.
    expect(shouldAdjustTerminalCoords('mousedown', LEFT, true, ZOOMED)).toBe(false)
    expect(shouldAdjustTerminalCoords('mousemove', LEFT, true, ZOOMED)).toBe(false)
    expect(shouldAdjustTerminalCoords('mouseup', LEFT, true, ZOOMED)).toBe(false)
  })

  it('does not adjust when the canvas is not zoomed (effective ~= 1)', () => {
    expect(shouldAdjustTerminalCoords('mousedown', LEFT, false, 1)).toBe(false)
    expect(shouldAdjustTerminalCoords('mousemove', LEFT, false, 1.0005)).toBe(false)
  })
})

// End-to-end story of the bug: model the terminal's capture-phase rewrite (gated
// by the real shouldAdjustTerminalCoords) feeding the canvas pan-delta math, and
// assert a middle-button drag on a zoomed canvas produces NO initial jump.
//
// The rewrite that fires in the capture phase, exactly as TerminalPanel does it:
//   adjusted = rect.left + (clientX - rect.left) / effective
// With rect.left = 0 this is clientX / effective.
function terminalRewrite(
  type: string,
  button: number,
  interacting: boolean,
  clientX: number,
  effective: number,
): number {
  if (!shouldAdjustTerminalCoords(type, button, interacting, effective)) return clientX
  return clientX / effective // rect.left = 0
}

describe('middle-click drag over a terminal does not offset the pan at the start', () => {
  const effective = ZOOMED

  it('records the pan origin and the first move in the same coordinate space', () => {
    // 1. Middle-button mousedown at raw client x = 400. canvas-interacting is
    //    NOT set yet (the canvas sets it in the bubble phase, after this capture
    //    handler). The pan records this as its origin (lastPanPos).
    const panOrigin = terminalRewrite('mousedown', MIDDLE, false, 400, effective)
    expect(panOrigin).toBe(400) // left RAW by the guard — not 200

    // 2. Pan is now active -> canvas-interacting is held. The pointer moves to
    //    raw client x = 410 (10px right). The move stays raw too.
    const firstMove = terminalRewrite('mousemove', LEFT, true, 410, effective)
    expect(firstMove).toBe(410)

    // 3. The canvas pan applies (move - origin) straight to the viewport offset.
    //    A 10px cursor move must pan exactly 10px: no jump.
    expect(firstMove - panOrigin).toBe(10)
  })

  it('would jump if the opening mousedown were adjusted (documents the bug)', () => {
    // If the guard were removed, the mousedown would be rewritten to 200 while
    // the first move stays raw at 410, so the first delta explodes to 210 — the
    // exact "offset at the beginning" the user reported. This asserts the failure
    // mode so the guard above is unmistakably load-bearing.
    const buggyOrigin = 400 / effective // 200, as an un-guarded rewrite would give
    const firstMove = 410
    expect(firstMove - buggyOrigin).not.toBe(10)
    expect(firstMove - buggyOrigin).toBe(210)
  })
})
