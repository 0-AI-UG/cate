// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/interaction/testing'
import { T3ConversationPill } from './T3ConversationPill'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const menu = vi.fn()
const select = vi.fn()
const conversations = {
  list: vi.fn(async () => [{ id: 'two', title: 'Other chat', updatedAt: '2026-09-05' }, { id: 'one', title: 'Current chat', updatedAt: '2026-09-04' }]),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  installMockClientUi({ showContextMenu: menu })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

async function open() {
  await act(async () => root.render(<T3ConversationPill title="Current chat" threadId="one" conversations={conversations} onSelect={select} />))
  await act(async () => host.querySelector('button')!.click())
}

it('lists chats for the checkout and switches the existing panel', async () => {
  menu.mockResolvedValue('two')
  await open()
  expect(conversations.list).toHaveBeenCalledOnce()
  expect(menu.mock.calls[0][0].slice(3)).toEqual([{ id: 'two', label: 'Other chat' }, { id: 'one', label: 'Current chat  ✓' }])
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'two', title: 'Other chat' }))
})

it('starts a new chat in the existing panel', async () => {
  menu.mockResolvedValue('__new')
  await open()
  expect(select).toHaveBeenCalledWith(undefined)
})

it('leaves the chat unchanged when the menu is dismissed', async () => {
  menu.mockResolvedValue(null)
  await open()
  expect(select).not.toHaveBeenCalled()
})

it('renames the bound conversation through a modal', async () => {
  menu.mockResolvedValue('__rename')
  await open()
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true')
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' Renamed ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(conversations.rename).toHaveBeenCalledWith('one', 'Renamed')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('dismisses rename with Escape from its buttons', async () => {
  menu.mockResolvedValue('__rename')
  await open()
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'Cancel')!
  cancel.focus()
  await act(async () => cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
