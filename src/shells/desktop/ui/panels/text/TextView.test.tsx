;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PanelRecord } from '@workspace/document/contract'
import type { PanelViewProps } from '../../client/host/views'
import { CanvasNodeFrameContext, type CanvasNodeFrame } from '../../client/layout/canvas/nodeFrame'

const h = vi.hoisted(() => ({ propose: vi.fn(() => ({ ok: true })), close: vi.fn(async () => true) }))
vi.mock('@client/document', () => ({ documentStoreFor: () => ({ propose: h.propose }) }))
vi.mock('@client/host', () => ({ closePanels: h.close }))

import TextView from './TextView'

const record = (text: string, color = 'default'): PanelRecord => ({ id: 't1', type: 'text', title: 'Text', fields: { text, color } })
let dragged = false
const frame: CanvasNodeFrame = { startDrag: vi.fn(), wasDragged: () => dragged, fit: vi.fn() }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  h.propose.mockClear()
  h.close.mockClear()
  vi.mocked(frame.startDrag).mockClear()
  vi.mocked(frame.fit).mockClear()
  dragged = false
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (text: string, focused = false, color?: string) => act(() => root.render(
  <CanvasNodeFrameContext.Provider value={frame}>
    <TextView {...({ workspaceId: 'w', panelId: 't1', record: record(text, color), focused } as PanelViewProps)} />
  </CanvasNodeFrameContext.Provider>,
))
const field = () => host.querySelector('textarea')!
const press = () => act(() => { field().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })

it('keeps its box size while the words fit', () => {
  render('Claude Code')
  expect(frame.fit).not.toHaveBeenCalled()
})

it('shows the style toolbar while focused, and saves size, weight and family', () => {
  render('Hi', true)
  act(() => field().blur())
  expect(host.querySelector('[role="toolbar"]')).not.toBeNull()
  const click = (label: string) => act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  click('Larger')
  expect(h.propose).toHaveBeenLastCalledWith({ kind: 'updatePanel', id: 't1', patch: { fields: { fontSize: 26 } } })
  click('Bold')
  expect(h.propose).toHaveBeenLastCalledWith({ kind: 'updatePanel', id: 't1', patch: { fields: { fontWeight: 'bold' } } })
  click('Serif')
  expect(h.propose).toHaveBeenLastCalledWith({ kind: 'updatePanel', id: 't1', patch: { fields: { fontFamily: 'serif' } } })
})

it('moves from its edge while editing', () => {
  render('Codex', true)
  act(() => { host.querySelector('[data-text-box]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
  expect(frame.startDrag).toHaveBeenCalledTimes(1)
})

it('is deleted from the toolbar', () => {
  render('Codex', true)
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete"]')!.click())
  expect(h.close).toHaveBeenCalledWith('w', ['t1'])
})

it('starts editing when a fresh text takes focus, with the colours above', () => {
  render('', true)
  expect(document.activeElement).toBe(field())
  expect(host.querySelector('[role="toolbar"]')).not.toBeNull()
})

it('moves on a press while not editing, and edits on a click that did not move', () => {
  render('Codex')
  press()
  expect(frame.startDrag).toHaveBeenCalledTimes(1)
  expect(document.activeElement).not.toBe(field())
  act(() => field().click())
  expect(document.activeElement).toBe(field())
  // Editing: a press is for the caret, not a move.
  press()
  expect(frame.startDrag).toHaveBeenCalledTimes(1)
})

it('does not start editing after a move', () => {
  render('Codex')
  press()
  dragged = true
  act(() => field().click())
  expect(document.activeElement).not.toBe(field())
})

it('saves a picked colour into the record', () => {
  render('Open Code', true)
  act(() => field().focus())
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Text color"]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Blue"]')!.click())
  expect(h.propose).toHaveBeenCalledWith({ kind: 'updatePanel', id: 't1', patch: { fields: { color: 'blue' } } })
})

it('goes away when left empty', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  render('', true)
  act(() => field().blur())
  expect(h.close).toHaveBeenCalledWith('w', ['t1'])
})

it('stays when left with words', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  render('Claude Code')
  act(() => field().focus())
  act(() => field().blur())
  expect(h.close).not.toHaveBeenCalled()
})
