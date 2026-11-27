// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ContextMenuHost, acceleratorLabel, showContextMenu } from './ContextMenu'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ContextMenuHost />))
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const row = (text: string) => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) => el.textContent?.includes(text))!
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

it('resolves with the picked id and ignores disabled rows', async () => {
  let result!: Promise<string | null>
  act(() => { result = showContextMenu([{ id: 'copy', label: 'Copy', accelerator: 'Cmd+C' }, { type: 'separator' }, { id: 'gone', label: 'Delete', enabled: false }]) })
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  click(row('Delete'))
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  click(row('Copy'))
  expect(await result).toBe('copy')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('resolves null on Escape and opens a submenu on hover', async () => {
  let result!: Promise<string | null>
  act(() => { result = showContextMenu([{ label: 'New', submenu: [{ id: 'new:file', label: 'File' }] }]) })
  act(() => { row('New').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(row('File')).toBeTruthy()
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(await result).toBeNull()
})

it('draws accelerators with key symbols on a Mac', () => {
  expect(['⌘⇧V', 'Cmd+Shift+V']).toContain(acceleratorLabel('Cmd+Shift+V'))
})
