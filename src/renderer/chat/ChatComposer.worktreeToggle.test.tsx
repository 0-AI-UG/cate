import React from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ChatComposer } from './ChatComposer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mouseClick = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ChatComposer worktree selector', () => {
  it('stays closed when its selector button is clicked a second time', () => {
    act(() => {
      root.render(
        <ChatComposer
          draft=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onStop={vi.fn()}
          disabled={false}
          running={false}
          worktrees={[{
            id: 'main',
            path: '/repo',
            branch: 'main',
            label: 'main',
            color: '#fff',
            isPrimary: true,
            isCurrent: true,
            isOrphan: false,
          }]}
          selectedWorktreeId="main"
          onPickWorktree={vi.fn()}
        />,
      )
    })
    const selector = host.querySelector('button[title="Worktree this task branches off and lands back into"]') as HTMLButtonElement

    mouseClick(selector)
    expect(document.body.querySelector('[role="listbox"]')).toBeTruthy()

    mouseClick(selector)
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })
})
