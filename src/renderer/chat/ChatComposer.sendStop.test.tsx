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

  it('selects plan mode from the plus menu and renders it inline', () => {
    const onPromptModeChange = vi.fn()
    renderComposer({ onPromptModeChange })

    expect(button('Toggle plan mode')).toBeNull()
    act(() => button('Add prompt mode')?.click())
    const createPlan = Array.from(document.body.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Create plan')) as HTMLButtonElement
    expect(createPlan).toBeTruthy()
    expect(host.contains(createPlan)).toBe(false)
    expect(createPlan.closest('.fixed')).toBeTruthy()

    act(() => createPlan.click())
    expect(onPromptModeChange).toHaveBeenCalledWith('plan')

    renderComposer({ promptMode: 'plan', onPromptModeChange })
    const planChip = button('Remove Create plan mode')
    expect(planChip).toBeTruthy()
    expect(planChip?.parentElement?.querySelector('textarea')).toBe(host.querySelector('textarea'))
    expect(host.textContent).toContain('Create plan')
  })

  it('selects canvas mode from the plus menu and renders it inline', () => {
    const onPromptModeChange = vi.fn()
    renderComposer({ onPromptModeChange })

    act(() => button('Add prompt mode')?.click())
    const manageCanvas = Array.from(document.body.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Manage canvas')) as HTMLButtonElement
    expect(manageCanvas).toBeTruthy()

    act(() => manageCanvas.click())
    expect(onPromptModeChange).toHaveBeenCalledWith('canvas')

    renderComposer({ promptMode: 'canvas', onPromptModeChange })
    expect(button('Remove Manage canvas mode')).toBeTruthy()
    expect(host.textContent).toContain('Manage canvas')
  })

  it('selects orchestration mode from the plus menu and renders it inline', () => {
    const onPromptModeChange = vi.fn()
    renderComposer({ onPromptModeChange })

    act(() => button('Add prompt mode')?.click())
    const orchestrate = Array.from(document.body.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Orchestrate agents')) as HTMLButtonElement
    expect(orchestrate).toBeTruthy()

    act(() => orchestrate.click())
    expect(onPromptModeChange).toHaveBeenCalledWith('orchestrate')

    renderComposer({ promptMode: 'orchestrate', onPromptModeChange })
    expect(button('Remove Orchestrate agents mode')).toBeTruthy()
    expect(host.textContent).toContain('Orchestrate agents')
  })

})

describe('ChatComposer popovers', () => {
  it('renders thinking controls in viewport space without a canvas node', () => {
    renderComposer({ onPickThinkingLevel: vi.fn() })
    const trigger = button('Reasoning effort: medium') as HTMLButtonElement
    trigger.getBoundingClientRect = () => ({
      top: 300,
      right: 420,
      bottom: 320,
      left: 400,
      width: 20,
      height: 20,
      x: 400,
      y: 300,
      toJSON: () => ({}),
    })

    act(() => trigger.click())

    const heading = Array.from(document.body.querySelectorAll('div'))
      .find((candidate) => candidate.textContent === 'Thinking level')
    const popover = heading?.parentElement
    expect(popover).toBeTruthy()
    expect(host.contains(popover ?? null)).toBe(false)
    expect(popover?.classList.contains('fixed')).toBe(true)
    expect(popover?.style.top).toBe('296px')
    expect(popover?.style.left).toBe('260px')
  })

  it('portals the model picker above overflow-clipped composers', () => {
    renderComposer({
      models: [{ provider: 'openai', model: 'gpt-test' }],
      onPickModel: vi.fn(),
    })
    const trigger = host.querySelector('button[title="Model for this chat"]') as HTMLButtonElement
    trigger.getBoundingClientRect = () => ({
      top: 300,
      right: 180,
      bottom: 320,
      left: 100,
      width: 80,
      height: 20,
      x: 100,
      y: 300,
      toJSON: () => ({}),
    })

    act(() => trigger.click())

    const search = document.body.querySelector('input[placeholder="Search models"]')
    const popover = search?.closest('div.absolute') as HTMLDivElement | null
    expect(popover).toBeTruthy()
    expect(host.contains(popover)).toBe(false)
    expect(popover?.style.position).toBe('fixed')
    expect(popover?.style.top).toBe('292px')
    expect(popover?.style.left).toBe('100px')
  })
})
