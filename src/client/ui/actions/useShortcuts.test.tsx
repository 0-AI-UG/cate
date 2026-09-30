import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { registerPanelDefinitions } from '@client/host'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import type { PanelRecord } from '@workspace/document/contract'
import { shouldRunShortcut, handleShortcutKey, registerKeyHandler, type KeyContext } from './useShortcuts'
import { bindAction, canRunAction, runAction } from './registry'
import { createUiStateStore, normalizeUiState, UI_STATE_DOCUMENT } from '../state/uiState'

registerPanelDefinitions([
  { type: 'terminal', label: 'Terminal', icon: 'terminal', requires: [], ownsKeyboard: true } as unknown as AnyPanelDefinition,
  { type: 'browser', label: 'Browser', icon: 'globe', requires: [], claimsShortcuts: ['zoomIn'] } as unknown as AnyPanelDefinition,
])

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  focusedPanel: null,
  keyboardOwned: false,
  textSurface: false,
  overlayOpen: false,
  ...over,
})
const panel = (type: string) => ({ id: 'p', type, title: '', fields: {} }) as PanelRecord
const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })

describe('shouldRunShortcut', () => {
  it('lets text surfaces keep undo and text deletion', () => {
    expect(shouldRunShortcut('undo', { repeat: false }, ctx({ textSurface: true }))).toBe(false)
    expect(shouldRunShortcut('undo', { repeat: false }, ctx())).toBe(true)
  })

  it('keeps undo for the canvas when a shell owns the keyboard, but gives the shell Cmd+Backspace', () => {
    const shell = ctx({ textSurface: true, keyboardOwned: true, focusedPanel: panel('terminal') })
    expect(shouldRunShortcut('undo', { repeat: false }, shell)).toBe(true)
    expect(shouldRunShortcut('deleteNode', { repeat: false }, shell)).toBe(false)
  })

  it('yields an action the focused panel claims', () => {
    expect(shouldRunShortcut('zoomIn', { repeat: false }, ctx({ focusedPanel: panel('browser') }))).toBe(false)
    expect(shouldRunShortcut('zoomOut', { repeat: false }, ctx({ focusedPanel: panel('browser') }))).toBe(true)
  })

  it('ignores held chords and lets an open overlay own the arrows', () => {
    expect(shouldRunShortcut('toggleTool', { repeat: true }, ctx())).toBe(false)
    expect(shouldRunShortcut('navigateUp', { repeat: false }, ctx({ overlayOpen: true }))).toBe(false)
  })
})

describe('keyboard dispatch', () => {
  it('runs the bound action and stops the event', () => {
    const run = vi.fn()
    stops.push(bindAction('openSettings', { run }))
    const event = new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true })
    handleShortcutKey(event)
    expect(run).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves unbound keys alone and lets key handlers go first', () => {
    const handler = vi.fn(() => true)
    stops.push(registerKeyHandler(handler))
    const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true })
    handleShortcutKey(event)
    expect(handler).toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not run an action whose features the client lacks', () => {
    const run = vi.fn()
    stops.push(bindAction('toggleMinimap', { run, requires: ['canvas'] }))
    expect(canRunAction('toggleMinimap')).toBe(false)
    expect(runAction('toggleMinimap')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('ui state', () => {
  it('normalizes a hand-edited file and persists edits to the device', async () => {
    expect(normalizeUiState({ minimapButtonCorner: 'middle', telemetryNoticeAcknowledgedVersion: -1, onboardingCompleted: 'yes' }))
      .toEqual({ minimapButtonCorner: 'bottom-right', telemetryNoticeAcknowledgedVersion: 0, onboardingCompleted: false })
    const device = createMemoryDeviceStore({ [UI_STATE_DOCUMENT]: { onboardingCompleted: true } })
    const store = createUiStateStore(device)
    expect(store.getSnapshot().loaded).toBe(false)
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ loaded: true, onboardingCompleted: true })
    store.set('minimapButtonCorner', 'top-left')
    await Promise.resolve()
    expect(await device.get(UI_STATE_DOCUMENT)).toEqual({ minimapButtonCorner: 'top-left', telemetryNoticeAcknowledgedVersion: 0, onboardingCompleted: true })
    device.change(UI_STATE_DOCUMENT, { onboardingCompleted: false })
    expect(store.getSnapshot().onboardingCompleted).toBe(false)
  })
})
