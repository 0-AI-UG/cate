import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/interaction/testing'
import type { WorkspaceSettingsMirror } from '@kernel/settings/client'
import { GitHubSettings } from './GitHubSettings'
import { WorktreeSettings } from './WorktreeSettings'
import { installFakeRuntime, mount, type Mounted } from './testing'

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
beforeEach(() => {
  rt = installFakeRuntime()
  installMockClientUi()
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('shows the GitHub account and opens pull requests', async () => {
  const onShow = vi.fn()
  await m.render(<GitHubSettings workspaceId="ws" onShowPullRequests={onShow} />)
  expect(m.host.textContent).toContain('Authenticated as alice')
  await act(async () => m.button('Pull requests').click())
  expect(onShow).toHaveBeenCalled()
})

it('starts GitHub sign-in when signed out', async () => {
  rt.vcs.githubConnection.mockResolvedValue({ status: 'signed-out', message: 'Not signed in' })
  rt.vcs.githubLogin.mockResolvedValue({ status: 'pending', code: 'ABCD-1234' })
  await m.render(<GitHubSettings workspaceId="ws" onShowPullRequests={vi.fn()} />)
  await act(async () => m.button('Sign in to GitHub').click())
  expect(rt.vcs.githubLogin).toHaveBeenCalledWith({ operation: 'start' })
  expect(m.host.textContent).toContain('ABCD-1234')
})

it('toggles closeWorktreePanelsOnDelete through the workspace settings', async () => {
  let value = true
  const listeners = new Set<() => void>()
  const settings = {
    get: () => value,
    set: vi.fn(async (_key: string, next: boolean) => { value = next; listeners.forEach((l) => l()) }),
    subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) },
  } as unknown as WorkspaceSettingsMirror
  await m.render(<WorktreeSettings settings={settings} />)
  const toggle = m.host.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await act(async () => toggle.click())
  expect(settings.set).toHaveBeenCalledWith('closeWorktreePanelsOnDelete', false)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})
