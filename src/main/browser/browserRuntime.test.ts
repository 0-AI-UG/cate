import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { BrowserRuntimeRegistry } from './browserRuntime'

function guest(id: number, command?: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>) {
  const events = new EventEmitter()
  let attached = false
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
    if (command) return command(method, params, sessionId)
    if (method === 'Accessibility.getFullAXTree') return {
      nodes: [{ role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 7 }],
    }
    return {}
  })
  return {
    id,
    events,
    isDestroyed: () => false,
    once: vi.fn(),
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    isLoading: () => false,
    send: vi.fn(),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true }),
      detach: vi.fn(() => { attached = false }),
      sendCommand,
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    },
  }
}

describe('BrowserRuntimeRegistry', () => {
  let runtime: BrowserRuntimeRegistry

  beforeEach(() => { runtime = new BrowserRuntimeRegistry() })

  it('binds automation to the full guest identity', async () => {
    const contents = guest(41)
    const identity = { workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1' }
    await runtime.attach(contents as never, identity)

    await expect(runtime.execute(41, { ...identity, tabId: 'tab-2' }, 'snapshot', {}))
      .resolves.toEqual({ error: 'browser-target-not-registered' })
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Accessibility.getFullAXTree', expect.anything())
  })

  it('creates revisioned refs from the bound guest accessibility tree', async () => {
    const contents = guest(42)
    const identity = { workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1' }
    await runtime.attach(contents as never, identity)
    const result = await runtime.execute(42, identity, 'snapshot', { interactiveOnly: true })

    expect(result).toMatchObject({
      result: {
        snapshotId: 's1',
        url: 'https://example.test/',
        refs: [{ ref: '@s1e1', role: 'button', name: 'Save' }],
        snapshot: '- button "Save" [ref=s1e1]',
      },
    })
  })

  it('invalidates accessibility refs when the main frame navigates', async () => {
    const contents = guest(43)
    const identity = { workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1' }
    await runtime.attach(contents as never, identity)
    await runtime.execute(43, identity, 'snapshot', { interactiveOnly: true })

    contents.events.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'new-main-frame' } })

    await expect(runtime.execute(43, identity, 'command', { command: ['click', '@s1e1'] }))
      .resolves.toEqual({ error: 'stale-browser-ref' })
  })

  it('merges same-origin and cross-origin frame trees and keeps refs session-bound', async () => {
    const contents = guest(45, async (method, params, sessionId) => {
      if (method === 'Page.getFrameTree') return {
        frameTree: {
          frame: { id: 'main' },
          childFrames: [
            { frame: { id: 'same', parentId: 'main' } },
            { frame: { id: 'cross', parentId: 'main' } },
          ],
        },
      }
      if (method === 'Accessibility.getFullAXTree') {
        if (sessionId === 'cross-session') return { nodes: [{ role: { value: 'button' }, name: { value: 'Cross-frame action' }, backendDOMNodeId: 9 }] }
        if (params?.frameId === 'same') return { nodes: [{ role: { value: 'button' }, name: { value: 'Same-frame action' }, backendDOMNodeId: 8 }] }
        return { nodes: [] }
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: sessionId === 'cross-session' ? 'cross-object' : 'same-object' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'yes' } }
      return {}
    })
    const identity = { workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1' }
    await runtime.attach(contents as never, identity)
    contents.events.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: 'cross-session', targetInfo: { type: 'iframe', targetId: 'cross' },
    })

    const snapshot = await runtime.execute(45, identity, 'snapshot', { interactiveOnly: true }) as {
      result: { refs: Array<{ ref: string; name: string }> }
    }
    expect(snapshot.result.refs.map((ref) => ref.name)).toEqual(['Same-frame action', 'Cross-frame action'])
    const crossRef = snapshot.result.refs[1].ref
    await expect(runtime.execute(45, identity, 'command', { command: ['get', 'attr', crossRef, 'data-clicked'] }))
      .resolves.toMatchObject({ result: { value: 'yes' } })
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      'DOM.resolveNode', expect.objectContaining({ backendNodeId: 9 }), 'cross-session',
    )
  })

  it('lets user input preempt an in-flight visible action', async () => {
    const contents = guest(44, async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'object-1' } }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 7 } }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } }
      return {}
    })
    const identity = { workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1' }
    await runtime.attach(contents as never, identity)
    let returnedControl = false
    contents.send.mockImplementation((_channel: string, active: boolean) => {
      if (!active && !returnedControl) {
        returnedControl = true
        queueMicrotask(() => runtime.noteUserInput(44))
      }
    })

    await expect(runtime.execute(44, identity, 'command', { command: ['click', '#save'] }))
      .resolves.toEqual({ error: 'browser-action-preempted-by-user' })
  })

  it('uploads an authorized file without returning its host path', async () => {
    let callCount = 0
    const contents = guest(46, async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'file-input' } }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 11 } }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 100, 0, 100, 30, 0, 30] } }
      if (method === 'Runtime.callFunctionOn') {
        callCount += 1
        return callCount === 1
          ? { result: { value: { file: true, enabled: true } } }
          : { result: { value: { name: 'report.pdf', size: 42, count: 1 } } }
      }
      return {}
    })
    const identity = { workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1' }
    await runtime.attach(contents as never, identity)

    const result = await runtime.execute(46, identity, 'command', {
      command: ['upload', '#attachment', '/authorized/private/report.pdf'],
    })
    expect(result).toMatchObject({ result: { ok: true, files: ['report.pdf'] } })
    expect(JSON.stringify(result)).not.toContain('/authorized/private')
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      'DOM.setFileInputFiles',
      { files: ['/authorized/private/report.pdf'], backendNodeId: 11 },
      undefined,
    )
  })

  it('waits for a selector without dropping it when no timeout option is present', async () => {
    const contents = guest(47, async (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'ready' } }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 12 } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
      return {}
    })
    const identity = { workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1' }
    await runtime.attach(contents as never, identity)

    await expect(runtime.execute(47, identity, 'readCommand', {
      command: ['wait', '#ready', '--state', 'visible'],
    })).resolves.toMatchObject({ result: { loading: false } })
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'document.querySelector("#ready")' }),
      undefined,
    )
  })
})
