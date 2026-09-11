import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreateWorktreeForm } from './CreateWorktreeForm'

vi.mock('../stores/gitStatusStore', () => ({ workspaceIdForRoot: () => 'ws' }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.assign(window.electronAPI, {
    gitFetch: vi.fn().mockResolvedValue(undefined),
    gitPrList: vi.fn().mockResolvedValue([]),
    gitBranchList: vi.fn().mockResolvedValue({
      branches: [{ name: 'main', isRemote: false }],
    }),
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('fetches with pruning and reloads branches and pull requests from the picker', async () => {
  await act(async () => root.render(
    <CreateWorktreeForm
      onSubmit={vi.fn()}
      onCheckoutPr={vi.fn()}
      onCancel={vi.fn()}
      defaultBaseBranch="main"
      rootPath="/repo"
    />,
  ))

  await act(async () => {
    [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('based on'))!.click()
  })
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh branches and pull requests"]')!.click()
  })

  expect(window.electronAPI.gitFetch).toHaveBeenCalledWith('/repo', undefined, 'ws')
  expect(window.electronAPI.gitBranchList).toHaveBeenCalledTimes(2)
  expect(window.electronAPI.gitPrList).toHaveBeenCalledTimes(2)
})
