// Coverage for ChatComposer's send/stop control, which has to serve two
// surfaces with different mid-run semantics.
//
// A steerable surface (the agent panel) folds Stop into the send button: typing
// while a turn runs means you intend to steer it, so Stop only appears with an
// empty draft. A non-steerable surface (the Cate Agent sidebar, where a message
// starts the next turn rather than redirecting the live one) must keep Stop as
// its own control, otherwise a run with a half-typed message is unstoppable.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import { ChatComposer } from './ChatComposer'

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

const renderComposer = (props: Partial<React.ComponentProps<typeof ChatComposer>>): void => {
  act(() => {
    root.render(
      <ChatComposer
        draft=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        disabled={false}
        running={false}
        {...props}
      />,
    )
  })
}

const button = (label: string): HTMLButtonElement | null =>
  host.querySelector(`button[aria-label="${label}"]`)

describe('ChatComposer send/stop', () => {
  it('shows only Send when idle', () => {
    renderComposer({})
    expect(button('Send')).toBeTruthy()
    expect(button('Stop')).toBeNull()
  })

  describe('steerable (agent panel)', () => {
    it('replaces Send with Stop while running on an empty draft', () => {
      renderComposer({ running: true })
      expect(button('Stop')).toBeTruthy()
      expect(button('Send')).toBeNull()
      expect(button('Steer')).toBeNull()
    })

    it('offers Steer instead of Stop once there is a draft to send', () => {
      renderComposer({ running: true, draft: 'do the thing' })
      expect(button('Steer')).toBeTruthy()
      expect(button('Stop')).toBeNull()
    })
  })

  describe('non-steerable (Cate Agent sidebar)', () => {
    it('keeps Stop alongside Send while running with a draft', () => {
      renderComposer({ running: true, draft: 'do the thing', canSteer: false })
      expect(button('Stop')).toBeTruthy()
      expect(button('Send')).toBeTruthy()
      expect(button('Steer')).toBeNull()
    })

    it('keeps Stop while running on an empty draft, with Send disabled', () => {
      renderComposer({ running: true, canSteer: false })
      expect(button('Stop')).toBeTruthy()
      expect(button('Send')?.disabled).toBe(true)
    })
  })

  it('withdraws every send control while compacting', () => {
    renderComposer({ running: true, draft: 'x', compactionActive: true })
    expect(button('Send')).toBeNull()
    expect(button('Steer')).toBeNull()
    expect(button('Stop')).toBeNull()
  })
})
