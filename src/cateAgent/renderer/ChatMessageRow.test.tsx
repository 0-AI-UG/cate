import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { AssistantMessage } from './codingStore'
import { MessageRow } from './ChatMessageRow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('assistant thinking presentation', () => {
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

  it('keeps live thinking text outside the transparent shimmer container', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      id: 'assistant-thinking',
      text: '',
      thinking: 'Reasoning remains readable while it streams.',
      streaming: true,
    }

    act(() => root.render(<MessageRow msg={msg} shimmer />))

    const row = host.firstElementChild as HTMLElement
    expect(row.className).not.toContain('cate-notif-pulse')
    expect(host.querySelector('button span')?.className).toContain('cate-notif-pulse')

    act(() => {
      host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.querySelector('pre')?.textContent).toContain('Reasoning remains readable')
  })
})
