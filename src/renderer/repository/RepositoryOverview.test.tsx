import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RepositoryOverview from './RepositoryOverview'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
vi.mock('../shells/LeftSidebarReopen', () => ({ LeftSidebarReopen: () => null, useLeftChromeInset: () => 0 }))
vi.mock('./SourceControlView', () => ({ SourceControlView: ({ rootPath }: { rootPath: string }) => <div>Changes for {rootPath}</div> }))
vi.mock('../pullRequests/PullRequestsOverview', () => ({ default: () => <div>Existing pull request list</div> }))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  useAppStore.setState({ selectedWorkspaceId: 'ws', workspaces: [{ id: 'ws', name: 'Project', rootPath: '/repo', panels: {}, color: '' }] })
  Object.assign(window.electronAPI, { gitFindRepos: vi.fn().mockResolvedValue(['/repo']), gitRemotes: vi.fn().mockResolvedValue([{ name: 'origin', fetchUrl: 'git@github.com:org/project.git', pushUrl: '' }]), openExternalUrl: vi.fn() })
  useUIStore.getState().openRepository()
})
afterEach(() => { act(() => root.unmount()); host.remove(); useUIStore.getState().setShowPullRequests(false) })
it('shows the local repository and safe GitHub actions, and reuses the pull request view', async () => {
  await act(async () => root.render(<RepositoryOverview />))
  expect(host.querySelector('header h1')?.textContent).toBe('Repository')
  expect(host.querySelector('header')?.textContent).not.toContain('Back')
  expect(host.textContent).toContain('/repo')
  expect(host.textContent).toContain('org/project')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Issues')!.click())
  expect(window.electronAPI.openExternalUrl).toHaveBeenCalledWith('https://github.com/org/project/issues')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Pull Requests')!.click())
  expect(host.textContent).toContain('Existing pull request list')
  expect(host.textContent).not.toContain('Changes for')
  expect(useAppStore.getState().workspaces[0].panels).toEqual({})
})
it('keeps pull requests available without an open local workspace', async () => {
  useAppStore.setState({ selectedWorkspaceId: '', workspaces: [] })
  useUIStore.getState().openRepository('pullRequests')
  await act(async () => root.render(<RepositoryOverview />))
  expect(host.textContent).toContain('Existing pull request list')
  expect(window.electronAPI.gitFindRepos).not.toHaveBeenCalled()
})

it('does not reuse the previous repository under a newly selected workspace', async () => {
  await act(async () => root.render(<RepositoryOverview />))
  vi.mocked(window.electronAPI.gitRemotes).mockClear()
  vi.mocked(window.electronAPI.gitFindRepos).mockReturnValue(new Promise(() => {}))
  await act(async () => useAppStore.setState({ selectedWorkspaceId: 'second', workspaces: [{ id: 'second', name: 'Second', rootPath: '/second', color: '', panels: {} }] }))
  expect(window.electronAPI.gitRemotes).not.toHaveBeenCalled()
  expect(host.textContent).not.toContain('Changes for /repo')
  expect(host.textContent).not.toContain('org/project')
})

it('shows shared loading feedback during discovery and remote lookup', async () => {
  let finishDiscovery!: (paths: string[]) => void
  vi.mocked(window.electronAPI.gitFindRepos).mockReturnValue(new Promise(resolve => { finishDiscovery = resolve }))
  vi.mocked(window.electronAPI.gitRemotes).mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(<RepositoryOverview />))
  expect(host.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain('Finding repositories')
  expect(host.querySelector('[role="status"] .animate-spin')).not.toBeNull()
  await act(async () => finishDiscovery(['/repo']))
  expect(host.querySelector('[aria-label="Loading repository connection"] .animate-spin')).not.toBeNull()
  expect(host.textContent).not.toContain('No remote connected')
})
