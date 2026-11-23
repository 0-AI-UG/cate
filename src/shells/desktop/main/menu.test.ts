import { expect, it, vi } from 'vitest'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

const menu = vi.hoisted(() => ({ build: vi.fn() }))
vi.mock('electron', () => ({ app: {}, shell: {}, Menu: { buildFromTemplate: menu.build } }))
import { showContextMenu } from './menu'

it('preserves native checkbox state and returns the selected item', async () => {
  menu.build.mockImplementation((items: MenuItemConstructorOptions[]) => ({
    popup: ({ callback }: { callback(): void }) => { (items[0].click as () => void)(); callback() },
  }))
  const selected = await showContextMenu({} as BrowserWindow, [
    { id: 'wrap', label: 'Wrap lines', type: 'checkbox', checked: true },
    { type: 'separator' },
    { id: 'collapse', label: 'Collapse all files', enabled: false },
  ])
  expect(menu.build.mock.calls[0][0]).toEqual([
    expect.objectContaining({ label: 'Wrap lines', type: 'checkbox', checked: true }),
    { type: 'separator' },
    expect.objectContaining({ label: 'Collapse all files', enabled: false }),
  ])
  expect(selected).toBe('wrap')
})
