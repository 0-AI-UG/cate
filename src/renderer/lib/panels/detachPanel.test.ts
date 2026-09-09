// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { detachPanel } from './detachPanel'
import type { PanelTransferSnapshot } from '../../../shared/types'
const snapshot = (text: string): PanelTransferSnapshot => ({ panel: { id: 'editor', type: 'editor', title: 'Editor', isDirty: true, unsavedContent: text }, sourceLocation: { type: 'dock', zone: 'center', stackId: 'stack' }, geometry: { origin: { x: 0, y: 0 }, size: { width: 500, height: 400 } } })
it('publishes edits made while the destination was loading before permitting source release', async () => {
  let ready!: (id: number) => void
  let current = snapshot('before')
  const commit = vi.fn().mockResolvedValue(true)
  Object.assign(window.electronAPI, { dragDetach: vi.fn(() => new Promise<number>(resolve => { ready = resolve })), commitPanelTransfer: commit, finishPanelTransfer: vi.fn() })
  const result = detachPanel(current, 'ws', () => current)
  current = snapshot('after'); ready(7)
  expect(await result).toBe(7)
  expect(commit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ panel: expect.objectContaining({ unsavedContent: 'after' }) }))
})
it('retains source ownership when acceptance fails or the source has disappeared', async () => {
  const commit = vi.fn().mockResolvedValue(false)
  Object.assign(window.electronAPI, { dragDetach: vi.fn().mockResolvedValue(7), commitPanelTransfer: commit, finishPanelTransfer: vi.fn() })
  expect(await detachPanel(snapshot('edits'), 'ws', () => snapshot('edits'))).toBeNull()
  expect(await detachPanel(snapshot('edits'), 'ws', () => null)).toBeNull()
  expect(commit).toHaveBeenLastCalledWith(expect.any(String), null)
})
it('retains late edits made while final snapshot publication is pending', async () => {
  let publish!: (accepted: boolean) => void
  let current = snapshot('before commit')
  const commit = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { publish = resolve })).mockResolvedValue(false)
  const finish = vi.fn()
  Object.assign(window.electronAPI, { dragDetach: vi.fn().mockResolvedValue(7), commitPanelTransfer: commit, finishPanelTransfer: finish })
  const transfer = detachPanel(current, 'ws', () => current)
  await Promise.resolve(); await Promise.resolve()
  current = snapshot('during commit'); publish(true)
  expect(await transfer).toBeNull()
  expect(finish).not.toHaveBeenCalled()
  expect(commit).toHaveBeenLastCalledWith(expect.any(String), null)
})

it('allows live terminal output to advance during acceptance', async () => {
  let publish!: (accepted: boolean) => void
  let current: PanelTransferSnapshot = { ...snapshot(''), panel: { id: 'terminal', type: 'terminal', title: 'Terminal', isDirty: false }, terminalPtyId: 'pty', terminalScrollback: 'before' }
  const finish = vi.fn()
  Object.assign(window.electronAPI, { dragDetach: vi.fn().mockResolvedValue(7), commitPanelTransfer: vi.fn(() => new Promise<boolean>(resolve => { publish = resolve })), finishPanelTransfer: finish })
  const transfer = detachPanel(current, 'ws', () => current)
  await Promise.resolve(); await Promise.resolve()
  current = { ...current, terminalScrollback: 'before\nafter' }; publish(true)
  expect(await transfer).toBe(7)
  expect(finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ terminalScrollback: 'before\nafter' }))
})
