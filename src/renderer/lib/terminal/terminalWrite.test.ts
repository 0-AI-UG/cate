// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  flush: vi.fn(async () => {}),
  write: vi.fn(async (_pty: string, _data: string) => {}),
  context: vi.fn(async () => {}),
}))
vi.mock('./registryState', () => ({ ptyToPanel: new Map([['pty', 'terminal']]), getEntry: () => undefined }))
vi.mock('../../stores/appStore', () => ({ useAppStore: { getState: () => ({ workspaces: [{ id: 'ws', panels: { terminal: {} } }] }) } }))
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ panelRelationsEnabled: true }) } }))
vi.mock('../../stores/statusStore', () => ({ useStatusStore: { getState: () => ({ workspaces: { ws: { terminals: { pty: { activity: { type: 'running', processName: 'codex' } } } } } }) } }))
vi.mock('../editor/connectedEditors', () => ({ connectedEditors: () => [{}], flushConnectedEditors: h.flush }))
vi.mock('../agent/panelRelationPrompt', () => ({ panelRelationContextForSend: () => 'Materialized path' }))
import { writeTerminalInput } from './terminalWrite'

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { electronAPI: { terminalWrite: h.write, agentHooksSetPromptContext: h.context } })
})

it('flushes files and publishes their paths before Enter, keeping subsequent input ordered', async () => {
  let finish!: () => void
  h.flush.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const enter = writeTerminalInput('pty', '\r')
  const later = writeTerminalInput('pty', 'next')
  expect(h.write).not.toHaveBeenCalled()
  expect(h.context).not.toHaveBeenCalled()
  finish(); await Promise.all([enter, later])
  expect(h.context).toHaveBeenCalledWith('pty', 'Materialized path')
  expect(h.context.mock.invocationCallOrder[0]).toBeLessThan(h.write.mock.invocationCallOrder[0])
  expect(h.write.mock.calls).toEqual([['pty', '\r'], ['pty', 'next']])
})

it('blocks submission on a conflict and allows a later retry', async () => {
  h.flush.mockRejectedValueOnce(new Error('Editor conflict'))
  await expect(writeTerminalInput('pty', '\r')).rejects.toThrow('Editor conflict')
  expect(h.write).not.toHaveBeenCalled()
  await writeTerminalInput('pty', '\r')
  expect(h.write).toHaveBeenCalledOnce()
})

it.each(['pasted prompt\n', '\x1b[13;5u'])('also flushes pasted and modified submissions (%j)', async data => {
  await writeTerminalInput('pty', data)
  expect(h.flush).toHaveBeenCalledWith('ws', 'terminal')
  expect(h.write).toHaveBeenCalledWith('pty', data)
})

it('does not delay ordinary typing or interrupt keys', async () => {
  const typing = writeTerminalInput('pty', 'a')
  expect(h.write).toHaveBeenCalledWith('pty', 'a')
  await typing
  await writeTerminalInput('pty', '\x03')
  expect(h.flush).not.toHaveBeenCalled()
})
