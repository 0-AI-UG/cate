import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { GitHubConnection } from '@workspace/repository/contract'
import { GitHubSettings } from './GitHubSettings'
import { installFakeRuntime, mount } from './testing'

it('does not offer sign-in before the runtime answers the account check', async () => {
  const rt = installFakeRuntime()
  const m = mount()
  let finish!: (connection: GitHubConnection) => void
  rt.vcs.githubConnection.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  try {
    await m.render(<GitHubSettings workspaceId="ws" onShowPullRequests={vi.fn()} />)
    expect(m.host.textContent).toContain('Checking GitHub')
    expect(m.host.textContent).not.toContain('Sign in to GitHub')
    await act(async () => finish({ status: 'connected', account: 'alice' }))
    expect(m.host.textContent).toContain('Authenticated as alice')
  } finally {
    m.unmount()
    rt.uninstall()
  }
})
