import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { WindowRegistry, type RegistryWindow } from './windowRegistry'

let next = 1
function fakeWindow(): RegistryWindow & EventEmitter & { focused: boolean; destroyed: boolean; sent: unknown[][] } {
  const id = next++
  const win = Object.assign(new EventEmitter(), {
    id,
    focused: false,
    destroyed: false,
    sent: [] as unknown[][],
    isDestroyed: () => win.destroyed,
    isFocused: () => win.focused,
    webContents: { id: id + 100, send: (...args: unknown[]) => { win.sent.push(args) } },
  })
  return win
}

describe('window registry', () => {
  it('tracks main and detached windows and forgets them on close', () => {
    const registry = new WindowRegistry()
    const main = fakeWindow()
    const detached = fakeWindow()
    const ref = { workspaceId: 'local:/w', windowId: 'win-1' }
    registry.register(main, 'main')
    registry.register(detached, 'detached', ref)
    expect(registry.findDetached(ref)?.win).toBe(detached)
    expect(registry.forContents(detached.webContents.id)?.kind).toBe('detached')
    expect(registry.detachedRefs()).toEqual([ref])
    const closed = vi.fn()
    registry.onClosed(closed)
    detached.emit('closed')
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'detached', ref }))
    expect(registry.findDetached(ref)).toBeUndefined()
    expect(registry.list().map((e) => e.win)).toEqual([main])
  })

  it('routes app actions to the last focused main window', () => {
    const registry = new WindowRegistry()
    const first = fakeWindow()
    const second = fakeWindow()
    registry.register(first, 'main')
    registry.register(second, 'main')
    expect(registry.activeMain()?.win).toBe(second)
    first.emit('focus')
    expect(registry.activeMain()?.win).toBe(first)
    first.emit('closed')
    expect(registry.activeMain()?.win).toBe(second)
  })

  it('broadcasts to every live window except one', () => {
    const registry = new WindowRegistry()
    const a = fakeWindow()
    const b = fakeWindow()
    const gone = fakeWindow()
    for (const w of [a, b, gone]) registry.register(w, 'main')
    gone.destroyed = true
    registry.broadcast('ch', [1, 2], { exceptContents: a.webContents.id })
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([['ch', 1, 2]])
    expect(gone.sent).toEqual([])
    b.focused = true
    expect(registry.focused()?.win).toBe(b)
  })
})
