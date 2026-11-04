import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { InlineJoinForm } from './InlineJoinForm'
import { INITIAL_UI_STATE, useUIStore } from '../state/uiStore'

const h = vi.hoisted(() => ({ join: vi.fn(async () => ({ id: 'paired:one' })), select: vi.fn(), app: { pair: vi.fn(), workspaces: {} } }))
vi.mock('@client/workspaces', () => ({ joinWorkspace: h.join, joinErrorMessage: (err: Error) => err.message }))
vi.mock('../app', () => ({ clientApp: () => h.app }))
vi.mock('../navigation', () => ({ selectWorkspace: h.select }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  h.join.mockReset().mockResolvedValue({ id: 'paired:one' })
  h.select.mockClear()
  useUIStore.setState({ ...INITIAL_UI_STATE, openDialogOpen: true, joinRequest: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useUIStore.setState(INITIAL_UI_STATE)
})

it('joins from a prefilled input, closes the picker, and selects the workspace', async () => {
  act(() => root.render(<InlineJoinForm request={{ code: 'cate://pair?token', machine: 'Studio' }} />))
  expect(host.querySelector('input')?.value).toBe('cate://pair?token')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(h.join).toHaveBeenCalledWith('cate://pair?token', { pair: h.app.pair, workspaces: h.app.workspaces })
  expect(h.select).toHaveBeenCalledWith('paired:one')
  expect(useUIStore.getState()).toMatchObject({ openDialogOpen: false, joinRequest: null })
})

it('keeps pending and failed joins in the same row, retaining the code for retry', async () => {
  let fail!: (error: Error) => void
  h.join.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  act(() => root.render(<InlineJoinForm request={{ code: 'my-token' }} />))
  const form = host.querySelector('form')!
  act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(host.querySelector('input')?.disabled).toBe(true)
  expect(host.querySelector('[aria-label="Joining"]')?.getAttribute('aria-busy')).toBe('true')
  await act(async () => fail(new Error('This invite expired.')))
  expect(host.querySelector('input')?.value).toBe('my-token')
  expect(host.querySelector('input')?.disabled).toBe(false)
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('This invite expired.')
  expect(form.className).toContain('h-8')
  expect(form.className).not.toContain('flex-col')
  expect(useUIStore.getState().openDialogOpen).toBe(true)
  expect(h.select).not.toHaveBeenCalled()
})

it('cancels inline without closing the picker', () => {
  act(() => root.render(<InlineJoinForm request={{}} />))
  act(() => (host.querySelector('[aria-label="Cancel"]') as HTMLButtonElement).click())
  expect(useUIStore.getState()).toMatchObject({ openDialogOpen: true, joinRequest: null })
  expect(h.join).not.toHaveBeenCalled()
})
