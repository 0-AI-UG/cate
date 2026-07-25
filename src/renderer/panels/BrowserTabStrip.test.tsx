import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))

import { BrowserTabStrip } from './BrowserTabStrip'

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

describe('BrowserTabStrip', () => {
  it('stays visible for one new tab and gives it the expected label', () => {
    act(() => {
      root.render(
        <BrowserTabStrip
          tabs={[{ id: 'tab-1', url: 'cate://newtab', title: '' }]}
          activeTabId="tab-1"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onNewTab={vi.fn()}
          onTogglePin={vi.fn()}
        />,
      )
    })

    expect(host.querySelector('[aria-label="Browser tabs"]')).toBeTruthy()
    expect(host.textContent).toContain('New Tab')
    expect(host.querySelector('button[aria-label="New tab"]')).toBeTruthy()
  })
})
