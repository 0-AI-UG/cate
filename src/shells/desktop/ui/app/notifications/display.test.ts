import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientStateStore, type ClientStateStore } from '@client/document'
import { installMockClientUi } from '@kernel/interaction/testing'
import { applyOp, createDocument, MAIN_WINDOW, type WorkspaceDocument } from '@workspace/document/contract'
import { createNotificationDisplay, onNotificationFocus, runNotificationAction } from './display'
import { createToastStore } from './toasts'
import type { NotificationEvent } from '@workspace/notifications/contract'

const h = vi.hoisted(() => ({
  doc: null as WorkspaceDocument | null,
  state: null as ClientStateStore | null,
}))

vi.mock('@client/document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@client/document')>()
  return {
    ...actual,
    documentStoreFor: (id: string) => (id === 'ws' && h.doc ? { getSnapshot: () => h.doc } : null),
    clientStateFor: (id: string) => (id === 'ws' ? h.state : null),
  }
})

const event: NotificationEvent = { kind: 'agent.needsInput', panelId: 'p1', title: 'Codex needs input', body: 'Codex is waiting.' }
const on = { notificationsEnabled: true, notifyOnlyWhenUnfocused: true }

beforeEach(() => {
  vi.useFakeTimers()
  const { doc } = applyOp(createDocument(), {
    kind: 'addPanel',
    record: { id: 'p1', type: 'terminal', title: 'Terminal', fields: {} },
    at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
  })
  h.doc = doc
  h.state = createClientStateStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('notification display', () => {
  it('shows an OS notification with a focus action', () => {
    const ui = installMockClientUi()
    const toasts = createToastStore()
    const display = createNotificationDisplay({ settings: () => on, isFocused: () => false, toasts })
    display.show('ws', event)
    vi.advanceTimersByTime(1_000)
    expect(ui.notify).toHaveBeenCalledWith({
      title: 'Codex needs input',
      body: 'Codex is waiting.',
      action: { type: 'focusPanel', workspaceId: 'ws', panelId: 'p1' },
    })
    expect(toasts.getSnapshot()).toEqual([])
  })

  it('falls back to a toast when the shell installed no notify', () => {
    installMockClientUi({ notify: undefined })
    const toasts = createToastStore()
    createNotificationDisplay({ settings: () => on, isFocused: () => false, toasts }).show('ws', event)
    vi.advanceTimersByTime(1_000)
    expect(toasts.getSnapshot()).toHaveLength(1)
  })

  it('is gated by the settings and the client focus at the time it fires', () => {
    const ui = installMockClientUi()
    let settings = on
    let focused = true
    const display = createNotificationDisplay({ settings: () => settings, isFocused: () => focused })

    display.show('ws', event)
    vi.advanceTimersByTime(1_000)
    expect(ui.notify).not.toHaveBeenCalled()

    focused = false
    settings = { ...on, notificationsEnabled: false }
    display.show('ws', event)
    vi.advanceTimersByTime(1_000)
    expect(ui.notify).not.toHaveBeenCalled()

    settings = { notificationsEnabled: true, notifyOnlyWhenUnfocused: false }
    focused = true
    display.show('ws', event)
    vi.advanceTimersByTime(1_000)
    expect(ui.notify).toHaveBeenCalledTimes(1)
  })

  it('debounces per panel: a burst shows once with the latest event, a cancel drops it', () => {
    const ui = installMockClientUi()
    const display = createNotificationDisplay({ settings: () => on, isFocused: () => false, debounceMs: 300 })

    display.show('ws', event)
    vi.advanceTimersByTime(200)
    display.show('ws', { ...event, title: 'Codex needs permission' })
    display.show('ws', { ...event, panelId: 'p2' })
    vi.advanceTimersByTime(299)
    expect(ui.notify).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(1)
    expect(ui.notify).toHaveBeenCalledTimes(2)
    expect(ui.notify.mock.calls.map(([n]) => n.title)).toEqual(['Codex needs permission', 'Codex needs input'])

    display.show('ws', event)
    display.cancel('ws', 'p1')
    vi.advanceTimersByTime(1_000)
    expect(ui.notify).toHaveBeenCalledTimes(2)
  })

  it('clicking a toast focuses its panel in client state', () => {
    installMockClientUi({ notify: undefined })
    const toasts = createToastStore()
    const focused = vi.fn()
    const off = onNotificationFocus(focused)
    createNotificationDisplay({ settings: () => on, isFocused: () => false, toasts }).show('ws', event)
    vi.advanceTimersByTime(1_000)
    toasts.getSnapshot()[0].onClick!()
    expect(h.state!.getSnapshot().focusedPanelId).toBe('p1')
    expect(h.state!.getSnapshot().activeTabs).toEqual({ s1: 'p1' })
    expect(focused).toHaveBeenCalledWith('ws', 'p1')
    off()
  })

  it('an action for a panel that is gone does nothing', () => {
    runNotificationAction({ type: 'focusPanel', workspaceId: 'ws', panelId: 'nope' })
    runNotificationAction({ type: 'focusPanel', workspaceId: 'other', panelId: 'p1' })
    expect(h.state!.getSnapshot().focusedPanelId).toBeNull()
  })
})
