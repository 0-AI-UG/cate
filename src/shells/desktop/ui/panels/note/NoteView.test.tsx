;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PanelRecord } from '@workspace/document/contract'
import type { PanelViewProps } from '../../client/host/views'
import { CanvasNodeFrameContext, type CanvasNodeFrame } from '../../client/layout/canvas/nodeFrame'

const h = vi.hoisted(() => ({ propose: vi.fn(() => ({ ok: true })) }))
vi.mock('@client/document', () => ({ documentStoreFor: () => ({ propose: h.propose }) }))

import NoteView from './NoteView'
import { TEXT_SAVE_DELAY_MS } from './useBlockText'

const record = (text: string): PanelRecord => ({ id: 'n1', type: 'note', title: 'Note', fields: { text } })
const frame: CanvasNodeFrame = { startDrag: vi.fn(), wasDragged: () => false, fit: vi.fn() }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  h.propose.mockClear()
  vi.mocked(frame.startDrag).mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.useFakeTimers()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const render = (text: string, focused: boolean) => act(() => root.render(
  <CanvasNodeFrameContext.Provider value={frame}>
    <NoteView {...({ workspaceId: 'w', panelId: 'n1', record: record(text), focused } as PanelViewProps)} />
  </CanvasNodeFrameContext.Provider>,
))
const field = () => host.querySelector('textarea')!

function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field(), text)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('invites a click to edit and starts editing when a fresh note takes focus', () => {
  render('', false)
  expect(field().placeholder).toBe('Click to edit…')
  expect(document.activeElement).not.toBe(field())
  render('', true)
  expect(document.activeElement).toBe(field())
})

it('does not grab the caret for a note that already has words', () => {
  render('kept', true)
  expect(document.activeElement).not.toBe(field())
})

it('moves the note from its top band', () => {
  render('', false)
  act(() => { host.querySelector('[data-note-handle]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(frame.startDrag).toHaveBeenCalledTimes(1)
})

it('saves the words into the record after a pause, in one op', () => {
  render('', true)
  type('h')
  type('hi')
  expect(h.propose).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(TEXT_SAVE_DELAY_MS) })
  expect(h.propose).toHaveBeenCalledTimes(1)
  expect(h.propose).toHaveBeenCalledWith({ kind: 'updatePanel', id: 'n1', patch: { fields: { text: 'hi' } } })
})

it('saves at once when the field is left', () => {
  render('', true)
  type('draft')
  act(() => field().blur())
  expect(h.propose).toHaveBeenCalledWith({ kind: 'updatePanel', id: 'n1', patch: { fields: { text: 'draft' } } })
})

it('shows words saved elsewhere while not typing', () => {
  render('one', false)
  expect(field().value).toBe('one')
  render('two', false)
  expect(field().value).toBe('two')
})
