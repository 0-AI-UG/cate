import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachSessions, closePanel, registerPanelDefinitions } from '@client/host'
import { installClientUi } from '@kernel/interaction'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { add, attachTestWorkspace, buildDocument, fakeSessions, testPanelDefinitions } from '../../../test/clientWorkspace'
import { createMobileClientUi } from './clientUi'
import { createMobileLinks } from './links'
import { installMobileCloseGuards } from './close'
import type { MobileBridge } from '../contract'

const confirm = vi.fn(async () => false)
let cleanup: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
  confirm.mockReset().mockResolvedValue(false)
  registerPanelDefinitions(testPanelDefinitions())
  installClientUi(createMobileClientUi(confirm as MobileBridge, createMobileLinks()))
  cleanup.push(installMobileCloseGuards())
})
afterEach(() => {
  for (const stop of cleanup.reverse()) stop()
  cleanup = []
  vi.useRealTimers()
})

function setup() {
  const workspace = attachTestWorkspace('ws', buildDocument([
    add('canvas', { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 'dock' }, 'canvas', { canvasId: 'C' }),
    add('terminal', { to: 'canvas', canvasId: 'C', nodeId: 'node', stackId: 'stack', rect: { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } } }),
  ]))
  const sessions = fakeSessions()
  cleanup.push(workspace.detach, attachSessions(sessions.connections))
  return { workspace, sessions }
}

const running = { status: 'running', activity: { type: 'running', processName: 'claude' } }

it('keeps a running agent terminal on the canvas when closing is cancelled', async () => {
  const { workspace, sessions } = setup()
  sessions.publish('terminal', running)
  expect(await closePanel('ws', 'terminal')).toBe(false)
  expect(workspace.confirmed().panels.terminal).toBeDefined()
  expect(confirm).toHaveBeenCalledWith('app.confirm', { message: expect.stringContaining('claude') })
  expect(sessions.refs('terminal')).toBe(0)
})

it.each(['terminal', 'canvas'])('carries confirmed discard for the agent terminal when closing %s', async (panelId) => {
  const { workspace, sessions } = setup()
  sessions.publish('terminal', running)
  confirm.mockResolvedValue(true)
  const propose = vi.spyOn(workspace.document, 'propose')
  expect(await closePanel('ws', panelId)).toBe(true)
  expect(propose).toHaveBeenCalledWith({ kind: 'removePanels', ids: [panelId], discard: ['terminal'] })
  expect(workspace.confirmed().panels.terminal).toBeUndefined()
  expect(sessions.refs('terminal')).toBe(0)
})

it('waits for a cold session snapshot before asking to stop the agent', async () => {
  const { sessions } = setup()
  const closing = closePanel('ws', 'terminal')
  expect(confirm).not.toHaveBeenCalled()
  sessions.publish('terminal', running)
  expect(await closing).toBe(false)
  expect(confirm).toHaveBeenCalledOnce()
})

it('closes an idle shell without asking and keeps a terminal whose state is unavailable', async () => {
  const { sessions } = setup()
  const closing = closePanel('ws', 'terminal')
  await vi.advanceTimersByTimeAsync(2000)
  expect(await closing).toBe(false)
  sessions.publish('terminal', { status: 'running', activity: { type: 'idle' } })
  expect(await closePanel('ws', 'terminal')).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
  expect(sessions.refs('terminal')).toBe(0)
})
