import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILT_IN_THEMES } from '@kernel/interaction/contract'
import type { ChatSnapshot } from '../contract'
import { createChatPageController } from './pageController'

const harness = { origin: 'http://127.0.0.1:49152', port: 49152, instanceId: 'inst', environmentId: 'env', session: { name: 't3_session', value: 'secret' } }
const snapshot = (threadId: string | null): ChatSnapshot => ({
  checkout: '/repo', threadId, phase: 'ready', error: null, harness, loadId: 1, connected: true, changes: null,
})

function controllerFor(threadId: string | null) {
  const reveal = vi.fn()
  const controller = createChatPageController({
    workspaceId: 'ws',
    panelId: 'chat',
    snapshot: snapshot(threadId),
    theme: BUILT_IN_THEMES[0],
    port: { run: vi.fn(), send: vi.fn(async () => undefined), reveal },
  })
  return { controller, reveal }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('chat page reveal', () => {
  it('shows a bound thread once the setup ran', () => {
    const { controller, reveal } = controllerFor('one')
    controller.navigation(`${harness.origin}/env/one`, true)
    expect(reveal).not.toHaveBeenCalled()
    controller.documentReady(`${harness.origin}/env/one`)
    expect(reveal).toHaveBeenLastCalledWith(true)
  })

  it('keeps a new chat hidden on the start page until its draft shows', () => {
    const { controller, reveal } = controllerFor(null)
    controller.documentReady(`${harness.origin}/`)
    expect(reveal).not.toHaveBeenCalled()
    controller.navigation(`${harness.origin}/draft/d1`, true)
    expect(reveal).toHaveBeenLastCalledWith(true)
    vi.runAllTimers()
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('shows the start page after a while, where it only stays to show an error', () => {
    const { controller, reveal } = controllerFor(null)
    controller.documentReady(`${harness.origin}/`)
    vi.advanceTimersByTime(3999)
    expect(reveal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reveal).toHaveBeenLastCalledWith(true)
  })

  it('hides the page while a new document loads', () => {
    const { controller, reveal } = controllerFor('one')
    controller.documentReady(`${harness.origin}/env/one`)
    controller.documentStarted()
    expect(reveal).toHaveBeenLastCalledWith(false)
    controller.navigation(`${harness.origin}/env/one`, true)
    expect(reveal).toHaveBeenCalledTimes(2)
    controller.documentReady(`${harness.origin}/env/one`)
    expect(reveal).toHaveBeenLastCalledWith(true)
  })

  it('does not show a disposed page', () => {
    const { controller, reveal } = controllerFor(null)
    controller.documentReady(`${harness.origin}/`)
    controller.dispose()
    vi.runAllTimers()
    expect(reveal).not.toHaveBeenCalled()
  })
})
