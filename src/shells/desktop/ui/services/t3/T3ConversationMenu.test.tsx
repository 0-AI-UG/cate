// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { T3ConversationMenu, type T3ConversationMenuTriggerProps } from './T3ConversationMenu'

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

const trigger = ({ ref, onClick, icon }: T3ConversationMenuTriggerProps) => <button ref={ref} type="button" onClick={onClick}>{icon}</button>

async function open() {
  await act(async () => root.render(<T3ConversationMenu target={target} menuSide="up" renderTrigger={trigger} />))
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
  await act(async () => root.render(<T3ConversationMenu target={target} menuSide="up" renderTrigger={trigger} />))
  await act(async () => host.querySelector('button')!.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('surfaces conversation loading failures', async () => {
  conversations.list.mockRejectedValue(new Error('Runtime unavailable'))
  await open()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Runtime unavailable')
})

const del = (title: string) => act(async () => (document.querySelector(`button[aria-label="Delete ${title}"]`) as HTMLButtonElement).click())
const cancel = (title: string) => act(async () => (document.querySelector(`button[aria-label="Cancel deleting ${title}"]`) as HTMLButtonElement).click())
const elapse = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

it('deletes a saved chat when its countdown runs out', async () => {
  vi.useFakeTimers()
  try {
    conversations.remove.mockResolvedValue(undefined)
    await open()
    await del('Fix login')
    await elapse(2900)
    expect(conversations.remove).not.toHaveBeenCalled()
    expect(document.querySelector('button[aria-label="Cancel deleting Fix login"]')).not.toBeNull()
    await elapse(100)
    expect(conversations.remove).toHaveBeenCalledWith('one')
    expect(document.querySelector('button[title="Fix login"]')).toBeNull()
    expect(document.querySelector('button[title="Add tests"]')).not.toBeNull()
  } finally { vi.useRealTimers() }
})

it('runs several countdowns at once and cancels one', async () => {
  vi.useFakeTimers()
  try {
    conversations.remove.mockResolvedValue(undefined)
    await open()
    await del('Fix login')
    await elapse(1000)
    await del('Add tests')
    await cancel('Fix login')
    await elapse(3000)
    expect(conversations.remove).toHaveBeenCalledOnce()
    expect(conversations.remove).toHaveBeenCalledWith('two')
    expect(document.querySelector('button[title="Fix login"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Delete Fix login"]')).not.toBeNull()
    expect(document.querySelector('button[title="Add tests"]')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('keeps the conversation when deletion fails', async () => {
  vi.useFakeTimers()
  try {
    conversations.remove.mockRejectedValue(new Error('Deletion failed'))
    await open()
    await del('Fix login')
    await elapse(3000)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Deletion failed')
    expect(document.querySelector('button[title="Fix login"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Delete Fix login"]')).not.toBeNull()
  } finally { vi.useRealTimers() }
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
