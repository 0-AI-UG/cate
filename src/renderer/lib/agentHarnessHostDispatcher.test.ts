import { describe, expect, it, vi } from 'vitest'
import { createAgentHarnessHostDispatcher } from './agentHarnessHostDispatcher'
import type { PanelTarget } from './panelTargetPicker'

const target = { kind: 'new', placement: { target: 'canvas' } } as unknown as PanelTarget
function host() {
  const actions = {
    pick: vi.fn(async () => target), openDiff: vi.fn(async () => true),
    openFile: vi.fn(), createAgent: vi.fn(), openExternal: vi.fn(),
  }
  return { ...actions, dispatcher: createAgentHarnessHostDispatcher('thread', actions) }
}

describe('chat host dispatcher', () => {
  it.each(['/etc/passwd', '../secret', 'src/../../secret', 'C:\\secret', '..\\secret'])('rejects unsafe file path %s before showing placement', async (filePath) => {
    const h = host()
    await expect(h.dispatcher.handle('file', { threadId: 'thread', filePath })).rejects.toThrow('outside')
    expect(h.pick).not.toHaveBeenCalled()
    expect(h.openFile).not.toHaveBeenCalled()
  })

  it('rejects stale threads and invalid URLs', async () => {
    const h = host()
    await expect(h.dispatcher.handle('diff', { threadId: 'other' })).rejects.toThrow('Conversation changed')
    await expect(h.dispatcher.handle('external', { url: 'file:///etc/passwd' })).rejects.toThrow('Unsupported')
    expect(h.openDiff).not.toHaveBeenCalled()
    expect(h.openExternal).not.toHaveBeenCalled()
  })

  it('does not open files after disposal while placement is pending', async () => {
    const h = host()
    let choose!: (value: PanelTarget) => void
    h.pick.mockImplementation(() => new Promise((resolve) => { choose = resolve }))
    const pending = h.dispatcher.handle('file', { filePath: 'src/index.ts' })
    h.dispatcher.dispose()
    choose(target)
    expect(await pending).toBeNull()
    expect(h.openFile).not.toHaveBeenCalled()
  })

  it('propagates cancellation and consumes handoff placements only once', async () => {
    const h = host()
    h.pick.mockResolvedValueOnce(null as unknown as PanelTarget)
    expect(await h.dispatcher.handle('place-agent', {})).toBeNull()
    const placementId = await h.dispatcher.handle('place-agent', {})
    expect(await h.dispatcher.handle('open-agent', { placementId, threadId: 'new', title: 'Title' })).toBe(true)
    await expect(h.dispatcher.handle('open-agent', { placementId, threadId: 'new' })).rejects.toThrow('expired')
    expect(h.createAgent).toHaveBeenCalledTimes(1)
  })

  it('propagates handoff failures and does not permit duplicate retries', async () => {
    const h = host()
    const placementId = await h.dispatcher.handle('place-agent', {})
    h.createAgent.mockImplementation(() => { throw new Error('Panel closed') })
    await expect(h.dispatcher.handle('open-agent', { placementId, threadId: 'new' })).rejects.toThrow('Panel closed')
    await expect(h.dispatcher.handle('open-agent', { placementId, threadId: 'new' })).rejects.toThrow('expired')
  })
})
