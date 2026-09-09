import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PullRequestsOverview from './PullRequestsOverview'
import { openPullRequest } from './openPullRequest'
vi.mock('./openPullRequest', () => ({ openPullRequest: vi.fn() }))
import { useUIStore } from '../stores/uiStore'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../shells/LeftSidebarReopen', () => ({ LeftSidebarReopen: () => null, useLeftChromeInset: () => 0 }))
let host: HTMLDivElement
let root: Root
const list = vi.fn()
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  Object.assign(window.electronAPI, { pullRequestsList: list, githubLogin: vi.fn().mockResolvedValue({ status: 'pending' }), openExternalUrl: vi.fn() })
  useUIStore.getState().setShowPullRequests(true)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useUIStore.getState().setShowPullRequests(false) })
it('shows sign-in without a workspace and starts login only when clicked', async () => {
  list.mockResolvedValue({ status: 'signed-out', message: 'Sign in to GitHub' })
  await act(async () => root.render(<PullRequestsOverview />))
  expect(window.electronAPI.githubLogin).not.toHaveBeenCalled()
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Sign in to GitHub')!
  await act(async () => button.click())
  expect(window.electronAPI.githubLogin).toHaveBeenCalledWith('start')
  expect(host.textContent).toContain('Starting GitHub sign-in')
})
it('shows PR metadata and opens the selected PR on GitHub', async () => {
  list.mockResolvedValue({ status: 'ready', account: 'alice', truncated: false, items: [{ id: 'pr', number: 42, title: 'Fix startup', url: 'https://github.com/org/repo/pull/42', repository: 'org/repo', author: 'alice', updatedAt: '2026-09-08T10:00:00Z', additions: 20, deletions: 3, draft: false, checks: 'SUCCESS', involvement: 'authored' }] })
  await act(async () => root.render(<PullRequestsOverview />))
  expect(host.textContent).toContain('Fix startup')
  expect(host.textContent).toContain('org/repo')
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="Open pull request on GitHub"]')!.click())
  expect(window.electronAPI.openExternalUrl).toHaveBeenCalledWith('https://github.com/org/repo/pull/42')
})

it('opens the selected PR in Cate and surfaces checkout failures', async () => {
  const pr = { id: 'pr', number: 42, title: 'Fix startup', repository: 'org/repo', author: 'alice', updatedAt: '2026-09-08T10:00:00Z', additions: 20, deletions: 3, involvement: 'authored' }
  list.mockResolvedValue({ status: 'ready', account: 'alice', truncated: false, items: [pr] })
  vi.mocked(openPullRequest).mockRejectedValue(new Error('Open your local org/repo project in Cate first.'))
  await act(async () => root.render(<PullRequestsOverview />))
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open in Cate')!.click())
  expect(openPullRequest).toHaveBeenCalledWith(pr)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Open your local org/repo project')
})

it('defaults to the connected repository and follows repository changes', async () => {
  const pr = { id: 'pr', number: 42, title: 'Matching request', repository: 'org/repo', author: 'alice', updatedAt: '2026-09-08T10:00:00Z', additions: 20, deletions: 3, involvement: 'authored' }
  list.mockResolvedValue({ status: 'ready', account: 'alice', truncated: false, items: [pr, { ...pr, id: 'other', repository: 'org/other', title: 'Other request' }] })
  await act(async () => root.render(<PullRequestsOverview initialRepository="org/repo" />))
  expect(host.textContent).toContain('Matching request')
  expect(host.textContent).not.toContain('Other request')
  await act(async () => root.render(<PullRequestsOverview initialRepository="org/other" />))
  expect(host.textContent).toContain('Other request')
  expect(host.textContent).not.toContain('Matching request')
})

it('shows shared loading feedback while pull requests are pending', async () => {
  list.mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(<PullRequestsOverview />))
  expect(host.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain('Loading pull requests')
  const refresh = host.querySelector('[aria-label="Refresh pull requests"]')!
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  expect(refresh.querySelector('.animate-spin')).not.toBeNull()
})
