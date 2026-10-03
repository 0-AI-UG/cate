import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/interaction/testing'
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
  expect(ui.openSettings).toHaveBeenCalledWith('source control')
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
