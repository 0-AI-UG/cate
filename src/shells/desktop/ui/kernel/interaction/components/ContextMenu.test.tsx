// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextMenuHost, acceleratorLabel, showContextMenu } from './ContextMenu'
import { useDialogLayer } from './dialogLayers'

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
const press = (key: string) => act(() => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
})

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

it('moves keyboard focus into a submenu and back to its parent row', async () => {
  let result!: Promise<string | null>
  act(() => {
    result = showContextMenu([{
      label: 'New',
      submenu: [
        { id: 'disabled', label: 'Disabled', enabled: false },
        { type: 'separator' },
        { id: 'file', label: 'File' },
        { id: 'folder', label: 'Folder' },
      ],
    }])
  })
  try {
    press('ArrowDown')
    press('ArrowRight')
    expect(document.activeElement).toBe(row('File'))
    press('ArrowDown')
    expect(document.activeElement).toBe(row('Folder'))
    press('ArrowLeft')
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(document.activeElement).toBe(row('New'))
    press('Enter')
    expect(document.activeElement).toBe(row('File'))
    press('Enter')
    expect(await result).toBe('file')
  } finally {
    press('Escape')
  }
})

it('restores keyboard focus to the trigger when the menu is dismissed', async () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  let result!: Promise<string | null>
  try {
    act(() => { result = showContextMenu([{ id: 'copy', label: 'Copy' }]) })
    expect(document.activeElement).toBe(document.querySelector('[role="menu"]'))
    press('Escape')
    expect(await result).toBeNull()
    expect(document.activeElement).toBe(trigger)
  } finally {
    trigger.remove()
  }
})

it('handles Escape before the dialog beneath the menu', async () => {
  const closeDialog = vi.fn()
  function Dialog() {
    useDialogLayer((event) => {
      event.stopImmediatePropagation()
      closeDialog()
    })
    return <ContextMenuHost />
  }
  act(() => root.render(<Dialog />))
  let result!: Promise<string | null>
  act(() => { result = showContextMenu([{ id: 'copy', label: 'Copy' }]) })
  try {
    press('Escape')
    expect(closeDialog).not.toHaveBeenCalled()
    expect(await result).toBeNull()
    press('Escape')
    expect(closeDialog).toHaveBeenCalledOnce()
  } finally {
    if (document.querySelector('[role="menu"]')) click(row('Copy'))
  }
})

it('draws accelerators with key symbols on a Mac', () => {
  expect(['⌘⇧V', 'Cmd+Shift+V']).toContain(acceleratorLabel('Cmd+Shift+V'))
})
