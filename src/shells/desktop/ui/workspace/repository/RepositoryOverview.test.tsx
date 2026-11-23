import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '../../../../../test/clientUi'
import { RepositoryOverview, type RepositoryTab } from './RepositoryOverview'
import { fakeHost, installFakeRuntime, mount, type Mounted } from './testing'

vi.mock('./SourceControlView', () => ({ SourceControlView: ({ rootPath }: { rootPath: string }) => <div>Changes for {rootPath}</div> }))
vi.mock('./PullRequestsOverview', () => ({ PullRequestsOverview: () => <div>Existing pull request list</div> }))

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
let ui: ReturnType<typeof installMockClientUi>
const header = (actions: React.ReactNode) => <header><h1>Repository</h1>{actions}</header>
beforeEach(() => {
  rt = installFakeRuntime()
  rt.vcs.findRepos.mockResolvedValue(['/repo'])
  rt.vcs.remotes.mockResolvedValue([{ name: 'origin', fetchUrl: 'git@github.com:org/project.git', pushUrl: '' }])
  ui = installMockClientUi()
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('shows the local repository and GitHub links, and switches to pull requests', async () => {
  let tab: RepositoryTab = 'changes'
  const onTabChange = vi.fn((next: RepositoryTab) => { tab = next })
  await m.render(<RepositoryOverview tab={tab} onTabChange={onTabChange} header={header} onOpenPullRequest={vi.fn()} />, fakeHost())
  expect(rt.vcs.findRepos).toHaveBeenCalledWith({ dir: '/repo', maxDepth: 3 })
  expect(m.host.textContent).toContain('/repo')
  expect(m.host.textContent).toContain('org/project')
  expect(m.host.textContent).toContain('Changes for /repo')
  await act(async () => m.button('Issues').click())
  expect(ui.openExternal).toHaveBeenCalledWith('https://github.com/org/project/issues')
  await act(async () => m.button('Pull Requests').click())
  expect(onTabChange).toHaveBeenCalledWith('pullRequests')
  await m.render(<RepositoryOverview tab={tab} onTabChange={onTabChange} header={header} onOpenPullRequest={vi.fn()} />)
  expect(m.host.textContent).toContain('Existing pull request list')
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="GitHub settings"]')!.click())
  expect(ui.openSettings).toHaveBeenCalledWith('github')
})

it('shows loading feedback during discovery and remote lookup', async () => {
  let finish!: (paths: string[]) => void
  rt.vcs.findRepos.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  rt.vcs.remotes.mockReturnValue(new Promise(() => {}))
  await m.render(<RepositoryOverview tab="changes" onTabChange={vi.fn()} header={header} onOpenPullRequest={vi.fn()} />, fakeHost())
  expect(m.host.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain('Finding repositories')
  await act(async () => finish(['/repo']))
  expect(m.host.querySelector('[aria-label="Loading repository connection"]')).not.toBeNull()
  expect(m.host.textContent).not.toContain('No remote connected')
})


it('does not claim no repositories when discovery fails', async () => {
  rt.vcs.findRepos.mockRejectedValue(new Error('Runtime unavailable'))
  await m.render(<RepositoryOverview tab="changes" onTabChange={vi.fn()} header={header} onOpenPullRequest={vi.fn()} />, fakeHost())
  expect(m.host.textContent).toContain('Runtime unavailable')
  expect(m.host.textContent).not.toContain('No Git repository found')
})

it('shows cached repositories and remotes while a reopen revalidates them', async () => {
  const view = <RepositoryOverview tab="changes" onTabChange={vi.fn()} header={header} onOpenPullRequest={vi.fn()} />
  await m.render(view, fakeHost())
  m.unmount()
  m = mount()
  rt.vcs.findRepos.mockReturnValue(new Promise(() => {}))
  rt.vcs.remotes.mockReturnValue(new Promise(() => {}))
  await m.render(view, fakeHost())
  expect(m.host.textContent).toContain('Changes for /repo')
  expect(m.host.textContent).toContain('org/project')
  expect(m.host.textContent).not.toContain('Finding repositories')
  expect(m.host.textContent).not.toContain('Loading remote')
})


it('selects repositories and remotes with inline controls', async () => {
  rt.vcs.findRepos.mockResolvedValue(['/repo', '/repo/tools'])
  rt.vcs.remotes.mockResolvedValue([
    { name: 'origin', fetchUrl: 'git@github.com:org/project.git', pushUrl: '' },
    { name: 'upstream', fetchUrl: 'git@github.com:upstream/project.git', pushUrl: '' },
  ])
  await m.render(<RepositoryOverview tab="changes" onTabChange={vi.fn()} header={header} onOpenPullRequest={vi.fn()} />, fakeHost())
  expect(m.host.querySelector('select')).toBeNull()
  await act(async () => m.button('upstream').click())
  expect(m.host.textContent).toContain('upstream/project')
  expect(ui.showContextMenu).not.toHaveBeenCalled()
  await act(async () => m.button('tools').click())
  expect(m.host.textContent).toContain('Changes for /repo/tools')
  expect(m.button('tools').getAttribute('aria-pressed')).toBe('true')
})
