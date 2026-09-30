import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/ui/testing'
import { PullRequestsOverview } from './PullRequestsOverview'
import { installFakeRuntime, mount, type Mounted } from './testing'

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
let ui: ReturnType<typeof installMockClientUi>
const item = { id: 'pr', number: 42, title: 'Fix startup', url: 'https://github.com/org/repo/pull/42', repository: 'org/repo', author: 'alice', updatedAt: '2026-09-08T10:00:00Z', additions: 20, deletions: 3, draft: false, checks: 'SUCCESS', involvement: 'authored' as const }
beforeEach(() => {
  rt = installFakeRuntime()
  rt.vcs.githubLogin.mockResolvedValue({ status: 'pending' })
  ui = installMockClientUi()
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('shows sign-in and starts login only when clicked', async () => {
  rt.vcs.pullRequests.mockResolvedValue({ status: 'signed-out', message: 'Sign in to GitHub' })
  await m.render(<PullRequestsOverview workspaceId="ws" onOpenPullRequest={vi.fn()} />)
  expect(rt.vcs.githubLogin).not.toHaveBeenCalled()
  await act(async () => m.button('Sign in to GitHub').click())
  expect(rt.vcs.githubLogin).toHaveBeenCalledWith({ operation: 'start' })
  expect(m.host.textContent).toContain('Starting GitHub sign-in')
})

it('shows PR metadata and opens the PR on GitHub', async () => {
  rt.vcs.pullRequests.mockResolvedValue({ status: 'ready', account: 'alice', truncated: false, items: [item] })
  await m.render(<PullRequestsOverview workspaceId="ws" onOpenPullRequest={vi.fn()} />)
  expect(m.host.textContent).toContain('Fix startup')
  expect(m.host.textContent).toContain('org/repo')
  await act(async () => m.host.querySelector<HTMLButtonElement>('button[title="Open pull request on GitHub"]')!.click())
  expect(ui.openExternal).toHaveBeenCalledWith('https://github.com/org/repo/pull/42')
})

it('opens the PR in Cate and surfaces failures', async () => {
  rt.vcs.pullRequests.mockResolvedValue({ status: 'ready', account: 'alice', truncated: false, items: [item] })
  const open = vi.fn().mockRejectedValue(new Error('Open your local org/repo project in Cate first.'))
  await m.render(<PullRequestsOverview workspaceId="ws" onOpenPullRequest={open} />)
  await act(async () => m.button('Open in Cate').click())
  expect(open).toHaveBeenCalledWith(item)
  expect(m.host.querySelector('[role="alert"]')?.textContent).toContain('Open your local org/repo project')
})

it('defaults to the connected repository and follows repository changes', async () => {
  rt.vcs.pullRequests.mockResolvedValue({ status: 'ready', account: 'alice', truncated: false, items: [{ ...item, title: 'Matching request' }, { ...item, id: 'other', repository: 'org/other', title: 'Other request' }] })
  await m.render(<PullRequestsOverview workspaceId="ws" initialRepository="org/repo" onOpenPullRequest={vi.fn()} />)
  expect(m.host.textContent).toContain('Matching request')
  expect(m.host.textContent).not.toContain('Other request')
  await m.render(<PullRequestsOverview workspaceId="ws" initialRepository="org/other" onOpenPullRequest={vi.fn()} />)
  expect(m.host.textContent).toContain('Other request')
  expect(m.host.textContent).not.toContain('Matching request')
})

it('shows loading feedback while pull requests are pending', async () => {
  rt.vcs.pullRequests.mockReturnValue(new Promise(() => {}))
  await m.render(<PullRequestsOverview workspaceId="ws" onOpenPullRequest={vi.fn()} />)
  expect(m.host.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain('Loading pull requests')
  expect(m.host.querySelector('[aria-label="Refresh pull requests"]')!.getAttribute('aria-busy')).toBe('true')
})
