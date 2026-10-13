import { expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, StrictMode } from 'react'
import type { MachineSetup } from '@runtime/daemon/contract'
import { MachineFolderDialog } from './MachineFolderDialog'

vi.mock('../navigation', () => ({ selectWorkspace: vi.fn(async () => true) }))

it('reaches the folder list under StrictMode, whose first check is cancelled', async () => {
  const aborts: Array<() => void> = []
  const setup = {
    // Like the real one: a cancel rejects what is running.
    ensureRuntime: vi.fn(() => new Promise((resolve, reject) => {
      aborts.push(() => reject(new Error('Cancelled.')))
      setTimeout(() => resolve({ home: '/home/u', installedNow: false }), 10)
    })),
    listDir: vi.fn(async (_m, path: string) => ({ path: path || '/home/u', dirs: ['app'] })),
    mkdir: vi.fn(),
    wslDistros: vi.fn(async () => []),
    cancel: vi.fn(async () => { aborts.shift()?.() }),
  } as unknown as MachineSetup
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(
    <StrictMode>
      <MachineFolderDialog machine={{ kind: 'wsl', distro: 'Arch' }} setup={setup} onClose={() => {}} />
    </StrictMode>,
  ))
  await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
  expect(document.body.textContent).toContain('app')
  expect(document.body.textContent).not.toContain('Cancelled')
  // The first check was cancelled and a second one ran.
  expect(setup.cancel).toHaveBeenCalledTimes(1)
  expect(setup.ensureRuntime).toHaveBeenCalledTimes(2)
  act(() => root.unmount())
  // Closing stops what still runs on the machine.
  expect(setup.cancel).toHaveBeenCalledTimes(2)
  host.remove()
})

it('shows the setup on its own, without the folder browser, until the runtime is there', async () => {
  let fail: (err: Error) => void = () => {}
  const setup = {
    ensureRuntime: vi.fn(() => new Promise((_resolve, reject) => { fail = reject })),
    listDir: vi.fn(),
    mkdir: vi.fn(),
    wslDistros: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
  } as unknown as MachineSetup
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<MachineFolderDialog machine={{ kind: 'wsl', distro: 'Arch' }} setup={setup} onClose={() => {}} />))
  expect(document.body.textContent).toContain('Connecting to WSL: Arch')
  expect(document.querySelector('[aria-label="Folders"]')).toBeNull()
  expect(document.querySelector('[aria-label="Folder path"]')).toBeNull()
  await act(async () => { fail(new Error('Permission denied.')) })
  expect(document.body.textContent).toContain('Could not set up WSL: Arch')
  expect(document.body.textContent).toContain('Permission denied.')
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(true)
  act(() => root.unmount())
  host.remove()
})
