import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCrossWindowDrag, type DragWindow } from './crossWindowDrag'
import { clampGhostSize, ghostHtml } from './dragGhost'

const payload = { workspaceId: 'local:/w', panelId: 'p1', title: 'Terminal', size: { width: 400, height: 300 } }

function setup(windows: DragWindow[] = [{ contentsId: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }]) {
  let cursor = { x: 50, y: 50 }
  const ghost = { show: vi.fn(), move: vi.fn(), setVisible: vi.fn(), destroy: vi.fn() }
  const broadcast = vi.fn()
  let n = 0
  const drag = createCrossWindowDrag({
    cursor: () => cursor,
    windows: () => windows,
    ghost,
    broadcast,
    anyFullscreen: () => false,
    newId: () => `drag-${++n}`,
    pollMs: 10,
    claimWaitMs: 40,
  })
  return { drag, ghost, broadcast, moveTo: (x: number, y: number) => { cursor = { x, y } } }
}

describe('cross-window drag', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('follows the cursor, hides the ghost over app windows and tells the other windows', () => {
    const { drag, ghost, broadcast, moveTo } = setup()
    const id = drag.start(1, payload)!
    expect(ghost.show).toHaveBeenCalledWith(payload)
    vi.advanceTimersByTime(10)
    expect(ghost.setVisible).toHaveBeenLastCalledWith(false)
    moveTo(500, 500)
    vi.advanceTimersByTime(10)
    expect(ghost.move).toHaveBeenLastCalledWith(500, 500)
    expect(ghost.setVisible).toHaveBeenLastCalledWith(true)
    expect(broadcast).toHaveBeenLastCalledWith('pointer', { dragId: id, payload, x: 500, y: 500 }, 1)
  })

  it('a target claiming within the wait wins the drop', async () => {
    const { drag, ghost, broadcast } = setup()
    const id = drag.start(1, payload)!
    const ended = drag.end(1, id)
    expect(ghost.destroy).toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith('ended', id, 1)
    expect(drag.claim(1, id)).toBeNull()
    expect(drag.claim(2, id)).toEqual(payload)
    expect(drag.claim(3, id)).toBeNull()
    await expect(ended).resolves.toEqual({ claimed: true })
    expect(drag.active()).toBeNull()
  })

  it('an unclaimed drop goes back to the source', async () => {
    const { drag } = setup()
    const id = drag.start(1, payload)!
    const ended = drag.end(1, id)
    vi.advanceTimersByTime(40)
    await expect(ended).resolves.toEqual({ claimed: false })
    expect(drag.claim(2, id)).toBeNull()
  })

  it('refuses to leave the window while any window is fullscreen', () => {
    const drag = createCrossWindowDrag({
      cursor: () => ({ x: 0, y: 0 }), windows: () => [], ghost: { show: vi.fn(), move: vi.fn(), setVisible: vi.fn(), destroy: vi.fn() },
      broadcast: vi.fn(), anyFullscreen: () => true, newId: () => 'x',
    })
    expect(drag.start(1, payload)).toBeNull()
  })

  it('clamps the ghost and escapes its title', () => {
    expect(clampGhostSize(5000, 10)).toEqual({ width: 800, height: 80 })
    expect(clampGhostSize(undefined, undefined)).toEqual({ width: 320, height: 200 })
    const html = ghostHtml({ ...payload, title: '<img src=x onerror=alert(1)>', iconSvg: '<script>x</script>' })
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
  })
})
