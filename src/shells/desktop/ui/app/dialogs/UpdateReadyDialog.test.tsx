import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { installDesktopPort, type DesktopPort, type UpdateStatus } from '../desktop'
import { UpdateReadyDialog } from './UpdateReadyDialog'

let root: Root
let host: HTMLDivElement
let status: (next: UpdateStatus) => void
let port: DesktopPort

const button = (label: string) => [...document.querySelectorAll('button')].find((el) => el.textContent?.includes(label))!

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  port = {
    updateStatus: vi.fn(async () => ({ state: 'downloaded', version: '2.1.0' })),
    onUpdateStatus: vi.fn((listener) => { status = listener; return () => {} }),
    dismissUpdate: vi.fn(async (version) => { status({ state: 'downloaded', version, dismissed: true }) }),
    quitAndInstallUpdate: vi.fn(async () => false),
  } as unknown as DesktopPort
  installDesktopPort(port)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installDesktopPort(null)
})

it('uses the shared dialog focus and Escape dismissal while leaving the update staged', async () => {
  await act(async () => root.render(<UpdateReadyDialog />))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Cate update ready')
  expect(document.activeElement).toBe(button('Install on next quit'))
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(port.dismissUpdate).toHaveBeenCalledWith('2.1.0')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(port.quitAndInstallUpdate).not.toHaveBeenCalled()
})

it('prevents dismissal during restart and restores controls when quit is cancelled', async () => {
  let finish!: (accepted: boolean) => void
  vi.mocked(port.quitAndInstallUpdate).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => root.render(<UpdateReadyDialog />))
  await act(async () => button('Restart now').click())
  expect(button('Restarting').disabled).toBe(true)
  expect(button('Install on next quit').disabled).toBe(true)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(port.dismissUpdate).not.toHaveBeenCalled()
  await act(async () => finish(false))
  expect(button('Restart now').disabled).toBe(false)
  expect(button('Install on next quit').disabled).toBe(false)
})
