// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ExplorerSidebar } from './ExplorerSidebar'

it('holds at minimum width and collapses only after the second drag threshold', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onHide = vi.fn()
  await act(async () => root.render(<ExplorerSidebar visible onHide={onHide}>Files</ExplorerSidebar>))
  const separator = host.querySelector('[role="separator"]') as HTMLElement
  const sidebar = host.querySelector('aside')!
  vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({ width: 260 } as DOMRect)
  separator.setPointerCapture = vi.fn()
  separator.releasePointerCapture = vi.fn()
  const pointer = async (type: string, clientX: number) => {
    await act(async () => separator.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX })))
  }
  await pointer('pointerdown', 300)
  await pointer('pointermove', 400)
  expect(sidebar.style.width).toBe('180px')
  expect(host.textContent).not.toContain('Release to hide explorer')
  expect(onHide).not.toHaveBeenCalled()
  await pointer('pointerup', 400)
  expect(onHide).not.toHaveBeenCalled()
  await pointer('pointerdown', 300)
  await pointer('pointermove', 500)
  await pointer('pointerup', 500)
  expect(onHide).toHaveBeenCalledOnce()
  await act(async () => root.unmount())
  host.remove()
})

it('fills the panel without a resize handle and restores the sidebar width', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onHide = vi.fn()
  const render = async (fill: boolean) => {
    await act(async () => root.render(<ExplorerSidebar visible fill={fill} onHide={onHide}>Files</ExplorerSidebar>))
  }
  await render(false)
  await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
  ))
  expect(host.querySelector('aside')!.style.width).toBe('276px')
  await render(true)
  expect(host.querySelector('aside')!.style.width).toBe('100%')
  expect(host.querySelector('aside')!.style.maxWidth).toBe('none')
  expect(host.querySelector('[role="separator"]')).toBeNull()
  expect(host.textContent).toBe('Files')
  await render(false)
  expect(host.querySelector('aside')!.style.width).toBe('276px')
  expect(host.querySelector('[role="separator"]')).not.toBeNull()
  await act(async () => root.unmount())
  host.remove()
})
