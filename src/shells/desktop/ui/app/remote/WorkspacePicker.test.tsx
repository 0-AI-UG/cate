import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { installMockClientUi } from '../../../../../test/clientUi'
import { WorkspacePicker } from './WorkspacePicker'

const h = vi.hoisted(() => ({
  select: vi.fn(),
  pickFolder: vi.fn(async () => null),
  snapshot: { entries: [
    { kind: 'local', id: 'older', name: 'Older', root: '/older', lastOpenedAt: 1 },
    { kind: 'machine', id: 'recent', name: 'Recent', root: '/recent', lastOpenedAt: 2, machine: { kind: 'ssh', target: { destination: 'studio' } } },
  ], open: [] },
  app: { workspaces: { restore: vi.fn(async () => {}), forget: vi.fn(async () => {}) }, pair: {}, machines: { sshHosts: async () => [{ alias: 'studio' }], wslDistros: async () => [] } },
}))
vi.mock('../app', () => ({ clientApp: () => h.app }))
vi.mock('../desktop', () => ({ useDesktopPort: () => ({ pickFolder: h.pickFolder }) }))
vi.mock('../navigation', () => ({ selectWorkspace: h.select, openLocalFolder: vi.fn() }))
vi.mock('../../client/workspaces', () => ({ useRecentWorkspaces: () => [h.snapshot.entries[1], h.snapshot.entries[0]] }))
vi.mock('../../kernel/settings', () => ({ useClientSetting: () => [] }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  h.select.mockClear()
  h.app.workspaces.restore.mockClear()
  h.app.workspaces.forget.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('leads with recent workspaces, identifies remote computers, and opens the selected entry', async () => {
  const picked = vi.fn()
  await act(async () => root.render(<WorkspacePicker onPicked={picked} />))
  const rows = [...host.querySelectorAll('[role="option"]')]
  expect(rows[0].textContent).toContain('Recent')
  expect(rows[0].textContent).toContain('studio')
  expect(rows[1].textContent).toBe('Older')
  await act(async () => (rows[0] as HTMLButtonElement).click())
  expect(h.app.workspaces.restore).toHaveBeenCalledWith('recent')
  expect(h.select).toHaveBeenCalledWith('recent')
  expect(picked).toHaveBeenCalledOnce()
})

it('always displays other computers and supports keyboard selection', async () => {
  await act(async () => root.render(<WorkspacePicker />))
  expect(host.textContent).not.toContain('Open on Another Computer…')
  expect(host.textContent).toContain('SSH config')
  const list = host.querySelector('[role="listbox"]')!
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(h.app.workspaces.restore).toHaveBeenCalledWith('recent')
  expect(h.select).toHaveBeenCalledWith('recent')
})

it('aligns each remove button within the row rather than the section heading', async () => {
  await act(async () => root.render(<WorkspacePicker />))
  const remove = host.querySelector('[aria-label="Remove Recent"]')!
  expect(remove.parentElement?.querySelector('[role="option"]')?.textContent).toContain('Recent')
  expect(remove.parentElement?.textContent).not.toContain('Recent workspaces')
})

it('removes a recent workspace only after confirmation without reopening it', async () => {
  const ui = installMockClientUi()
  await act(async () => root.render(<WorkspacePicker />))
  const remove = host.querySelector('[aria-label="Remove Recent"]') as HTMLButtonElement
  await act(async () => remove.click())
  expect(h.app.workspaces.forget).not.toHaveBeenCalled()
  ui.confirm.mockResolvedValueOnce(true)
  await act(async () => remove.click())
  expect(h.app.workspaces.forget).toHaveBeenCalledWith('recent')
  expect(h.select).not.toHaveBeenCalled()
})
