import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../shared/electron-api'
import { UpdateButton } from './UpdateButton'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let emit: (status: UpdateStatus) => void
let resolveInitial: (status: UpdateStatus) => void
const check = vi.fn()
const unsubscribe = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  check.mockReset().mockResolvedValue(undefined)
  unsubscribe.mockClear()
  vi.stubGlobal('electronAPI', {
    onUpdateStatus: (callback: typeof emit) => { emit = callback; return unsubscribe },
    getUpdateStatus: () => new Promise<UpdateStatus>((resolve) => { resolveInitial = resolve }),
    checkForUpdates: check,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<UpdateButton />))
})
afterEach(() => {
  vi.restoreAllMocks()
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const button = () => host.querySelector('button')!

it('shows checking and download progress, prevents duplicate actions, then offers the restart dialog', async () => {
  act(() => emit({ state: 'checking', version: null }))
  expect(button().getAttribute('aria-label')).toBe('Checking for updates…')
  expect(host.querySelector('.animate-spin')).not.toBeNull()
  act(() => button().click())
  expect(check).not.toHaveBeenCalled()
  act(() => emit({ state: 'downloading', version: '2.0.0', percent: 38 }))
  expect(button().getAttribute('aria-label')).toContain('38%')
  act(() => button().click())
  expect(check).not.toHaveBeenCalled()
  act(() => emit({ state: 'downloaded', version: '2.0.0' }))
  expect(button().getAttribute('aria-label')).toBe('Restart to update to v2.0.0')
  await act(async () => { button().click(); button().click() })
  expect(check).toHaveBeenCalledOnce()
})

it('shows a dismissible up-to-date message only for manual checks', () => {
  act(() => emit({ state: 'up-to-date', version: null }))
  expect(document.querySelector('[role="status"]')).toBeNull()
  act(() => emit({ state: 'up-to-date', version: null, manual: true }))
  expect(document.querySelector('[role="status"]')?.textContent).toContain('You’re up to date')
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss update message"]')!.click())
  expect(document.querySelector('[role="status"]')).toBeNull()
})

it('centers update feedback above the button using the rendered message width', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'status') {
      return { left: 0, top: 0, right: 144, bottom: 40, width: 144, height: 40, x: 0, y: 0, toJSON: () => ({}) }
    }
    if (this === button()) {
      return { left: 180, top: 700, right: 212, bottom: 732, width: 32, height: 32, x: 180, y: 700, toJSON: () => ({}) }
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
  })

  act(() => emit({ state: 'up-to-date', version: null, manual: true }))

  const popup = document.querySelector<HTMLElement>('[role="status"]')!
  expect(popup.style.left).toBe('124px')
  expect(popup.style.visibility).toBe('visible')
})

it('surfaces errors and lets the user retry', async () => {
  act(() => emit({ state: 'error', version: null, message: 'Offline', manual: true }))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Offline')
  expect(button().getAttribute('aria-label')).toContain('Click to retry')
  check.mockRejectedValueOnce(new Error('Connection lost'))
  await act(async () => button().click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Connection lost')
  await act(async () => button().click())
  expect(check).toHaveBeenCalledTimes(2)
})

it('does not overwrite a live event with a stale initial snapshot', async () => {
  act(() => emit({ state: 'downloaded', version: '2.0.0' }))
  await act(async () => resolveInitial({ state: 'idle', version: null }))
  expect(button().getAttribute('aria-label')).toContain('Restart to update')
})
