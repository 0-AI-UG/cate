import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreateWorktreeForm } from './CreateWorktreeForm'
import { installFakeRuntime, mount, type Mounted } from './testing'

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
beforeEach(() => {
  rt = installFakeRuntime()
  rt.vcs.branchList.mockResolvedValue({ current: 'main', branches: [{ name: 'main', current: true, commit: 'a', label: '', isRemote: false }] })
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('fetches and reloads branches and pull requests from the picker', async () => {
  await m.render(<CreateWorktreeForm onSubmit={vi.fn()} onCheckoutPr={vi.fn()} onCancel={vi.fn()} defaultBaseBranch="main" workspaceId="ws" rootPath="/repo" />)
  await act(async () => [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('based on'))!.click())
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Refresh branches and pull requests"]')!.click())
  expect(rt.vcs.fetch).toHaveBeenCalledWith({ cwd: '/repo' })
  expect(rt.vcs.branchList).toHaveBeenCalledTimes(2)
  expect(rt.vcs.prList).toHaveBeenCalledTimes(2)
})

it('submits the typed name with the picked base', async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  await m.render(<CreateWorktreeForm onSubmit={onSubmit} onCheckoutPr={vi.fn()} onCancel={vi.fn()} defaultBaseBranch="main" workspaceId="ws" rootPath="/repo" />)
  const input = m.host.querySelector('input')!
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, 'fix login')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Start"]')!.click())
  expect(onSubmit).toHaveBeenCalledWith('fix login', undefined)
})
