import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubSettings } from './GitHubSettings'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  Object.assign(window.electronAPI, { githubConnection: vi.fn(), githubLogin: vi.fn(), openExternalUrl: vi.fn() })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })
it('shows the authenticated account and CLI version without starting login', async () => {
  vi.mocked(window.electronAPI.githubConnection).mockResolvedValue({ status: 'connected', account: 'alice', version: 'gh version 2.96.0' })
  await act(async () => root.render(<GitHubSettings />))
  expect(host.textContent).toContain('Authenticated as alice')
  expect(host.textContent).toContain('gh version 2.96.0')
  expect(window.electronAPI.githubLogin).not.toHaveBeenCalled()
})
it('completes device sign-in and refreshes the connected account', async () => {
  vi.useFakeTimers()
  vi.mocked(window.electronAPI.githubConnection).mockResolvedValueOnce({ status: 'signed-out', message: 'Sign in' }).mockResolvedValue({ status: 'connected', account: 'alice' })
  vi.mocked(window.electronAPI.githubLogin).mockResolvedValueOnce({ status: 'pending', code: 'ABCD-1234' }).mockResolvedValue({ status: 'complete' })
  await act(async () => root.render(<GitHubSettings />))
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Sign in to GitHub')!.click())
  expect(host.textContent).toContain('ABCD-1234')
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(host.textContent).toContain('Authenticated as alice')
  expect(host.textContent).not.toContain('ABCD-1234')
})
it('offers installation when the CLI is missing', async () => {
  vi.mocked(window.electronAPI.githubConnection).mockResolvedValue({ status: 'missing-cli', message: 'Install GitHub CLI' })
  await act(async () => root.render(<GitHubSettings />))
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Install GitHub CLI')!.click())
  expect(window.electronAPI.openExternalUrl).toHaveBeenCalledWith('https://cli.github.com/')
})
