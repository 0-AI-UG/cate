// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { T3ConversationMenu } from './T3ConversationMenu'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const conversations = { list: vi.fn(), rename: vi.fn(), remove: vi.fn() }
const openThread = vi.fn()
const target = vi.fn(() => ({ conversations, open: openThread }))
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  target.mockImplementation(() => ({ conversations, open: openThread }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  conversations.list.mockResolvedValue([{ id: 'one', title: 'Fix login', updatedAt: '2026-09-05' }, { id: 'two', title: 'Add tests', updatedAt: '2026-09-04' }])
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

async function open() {
  await act(async () => root.render(<T3ConversationMenu target={target} menuSide="up" />))
  expect(conversations.list).not.toHaveBeenCalled()
  await act(async () => host.querySelector('button')!.click())
}
const button = (text: string) => [...document.querySelectorAll('button')].find((el) => el.textContent === text)!

it('loads saved conversations on demand and opens the chosen one', async () => {
  await open()
  expect(target).toHaveBeenCalledOnce()
  expect(conversations.list).toHaveBeenCalledOnce()
  const input = document.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'login')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('Add tests')
  await act(async () => (document.querySelector('button[title="Fix login"]') as HTMLButtonElement).click())
  expect(openThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'one', title: 'Fix login' }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('opens a new unbound conversation', async () => {
  await open()
  await act(async () => button('New conversation').click())
  expect(openThread).toHaveBeenCalledWith(undefined)
})

it('stays closed without a target', async () => {
  target.mockReturnValue(null as never)
  await act(async () => root.render(<T3ConversationMenu target={target} menuSide="up" />))
  await act(async () => host.querySelector('button')!.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('surfaces conversation loading failures', async () => {
  conversations.list.mockRejectedValue(new Error('Runtime unavailable'))
  await open()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Runtime unavailable')
})

it('requires confirmation before deleting a saved chat', async () => {
  conversations.remove.mockResolvedValue(undefined)
  await open()
  await act(async () => (document.querySelector('button[aria-label="Delete Fix login"]') as HTMLButtonElement).click())
  expect(conversations.remove).not.toHaveBeenCalled()
  await act(async () => button('Delete').click())
  expect(conversations.remove).toHaveBeenCalledWith('one')
  expect(document.querySelector('button[title="Fix login"]')).toBeNull()
  expect(document.querySelector('button[title="Add tests"]')).not.toBeNull()
})

it('keeps the conversation when deletion fails', async () => {
  conversations.remove.mockRejectedValue(new Error('Deletion failed'))
  await open()
  await act(async () => (document.querySelector('button[aria-label="Delete Fix login"]') as HTMLButtonElement).click())
  await act(async () => button('Delete').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Deletion failed')
  await act(async () => button('Cancel').click())
  expect(document.querySelector('button[title="Fix login"]')).not.toBeNull()
})

it('renames a saved conversation and keeps editing when saving fails', async () => {
  conversations.rename.mockRejectedValueOnce(new Error('Save failed')).mockResolvedValueOnce(undefined)
  await open()
  await act(async () => (document.querySelector('button[aria-label="Rename Fix login"]') as HTMLButtonElement).click())
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Conversation name"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  Login repaired  ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await act(async () => { submit() })
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Save failed')
  expect(input.value).toBe('  Login repaired  ')
  await act(async () => { submit() })
  expect(conversations.rename).toHaveBeenLastCalledWith('one', 'Login repaired')
  expect(document.querySelector('button[title="Login repaired"]')).not.toBeNull()
  expect(openThread).not.toHaveBeenCalled()
})
