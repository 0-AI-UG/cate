import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Sidebar } from '../sidebar/Sidebar'
import { SettingsWindow } from './SettingsWindow'

vi.mock('./GeneralSettings', () => ({ GeneralSettings: () => <div>General content</div> }))
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => <div>Appearance content</div> }))
vi.mock('./CanvasSettings', () => ({ CanvasSettings: () => <div>Canvas content</div> }))
vi.mock('./TerminalSettings', () => ({ TerminalSettings: () => <div>Terminal content</div> }))
vi.mock('./BrowserSettings', () => ({ BrowserSettings: () => <div>Browser content</div> }))
vi.mock('./CliSettings', () => ({ CliSettings: () => <div>Cli content</div> }))
vi.mock('./SidebarSettings', () => ({ SidebarSettings: () => <div>Sidebar content</div> }))
vi.mock('./FileExplorerSettings', () => ({ FileExplorerSettings: () => <div>FileExplorer content</div> }))
vi.mock('./WorktreeSettings', () => ({ WorktreeSettings: () => <div>Worktree content</div> }))
vi.mock('./ShortcutSettings', () => ({ ShortcutSettings: () => <div>Shortcut content</div> }))
vi.mock('./NotificationSettings', () => ({ NotificationSettings: () => <div>Notification content</div> }))
vi.mock('./UpdatesSettings', () => ({ UpdatesSettings: () => <div>Updates content</div> }))
vi.mock('./AgentSettings', () => ({ AgentSettings: () => <div>Agent content</div> }))
vi.mock('./GitHubSettings', () => ({ GitHubSettings: () => <div>GitHub content</div> }))
vi.mock('./SkillsSettings', () => ({ SkillsSettings: () => <div>Skills content</div> }))

const initialUI = useUIStore.getState()
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  act(() => root.unmount())
  host.remove()
  useUIStore.setState(initialUI, true)
})

it('uses the Workspace sidebar for settings with only Back and updates in its footer', () => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  useUIStore.setState({ showSettings: true, leftSidebarHidden: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<>
    <div data-left><Sidebar /></div>
    <div id="settings-content-slot" />
    <SettingsWindow isOpen onClose={() => useUIStore.getState().closeSettings()} initialTab="providers" />
  </>))
  const left = host.querySelector('[data-left]')!
  expect(left.querySelector('#settings-sidebar-slot')?.querySelector('input')?.getAttribute('placeholder')).toBe('Search settings…')
  expect(host.querySelectorAll('aside')).toHaveLength(0)
  expect(host.querySelector('#settings-content-slot main')).not.toBeNull()
  expect(host.querySelector('#settings-content-slot header h1')?.textContent).toBe('Settings')
  expect(host.querySelector('#settings-content-slot header')?.textContent).not.toContain('/')
  const resetAll = vi.spyOn(useSettingsStore.getState(), 'resetAll').mockImplementation(() => {})
  const restoreButton = [...host.querySelectorAll('header button')].find((button) => button.textContent?.trim() === 'Restore defaults') as HTMLButtonElement
  expect(restoreButton).toBeDefined()
  act(() => restoreButton.click())
  expect(resetAll).toHaveBeenCalledOnce()
  expect(left.querySelector('[aria-label="Check for updates"]')).not.toBeNull()
  for (const label of ['Skills', 'Saved Layouts', 'Usage', 'Settings']) {
    expect(left.querySelector(`[aria-label="${label}"]`)).toBeNull()
  }
  expect(left.querySelector('[aria-label="Cate"]')).not.toBeNull()
  expect(left.querySelector('[aria-label="Hide sidebar"]')).not.toBeNull()
  expect(left.querySelector('[data-sidebar-icon]')).toBeNull()
  expect((left.querySelector('[data-sidebar-scrollarea]') as HTMLElement).style.width).not.toBe('0px')
  const agents = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Agents')!
  act(() => agents.click())
  expect(left.querySelector('[aria-current="page"]')?.textContent).toBe('T3 Code')
  expect(host.querySelector('header')?.textContent).not.toContain('T3 Code')
  expect(host.querySelector('header')?.textContent).toContain('Settings')
  const checkForUpdates = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('electronAPI', { ...window.electronAPI, checkForUpdates })
  act(() => left.querySelector<HTMLButtonElement>('[aria-label="Check for updates"]')!.click())
  expect(checkForUpdates).toHaveBeenCalledOnce()
  act(() => left.querySelector<HTMLButtonElement>('[aria-label="Hide sidebar"]')!.click())
  expect(useUIStore.getState().showSettings).toBe(true)
  expect((left.querySelector('[data-sidebar-scrollarea]') as HTMLElement).style.width).toBe('0px')
  const reopenButton = host.querySelector<HTMLButtonElement>('#settings-content-slot [aria-label="Show sidebar"]')!
  expect(reopenButton).not.toBeNull()
  act(() => reopenButton.click())
  expect(useUIStore.getState()).toMatchObject({ showSettings: true, leftSidebarHidden: false })
  expect((left.querySelector('[data-sidebar-scrollarea]') as HTMLElement).style.width).not.toBe('0px')
  act(() => left.querySelector<HTMLButtonElement>('[aria-label="Hide sidebar"]')!.click())
  const backButton = [...left.querySelectorAll('button')].find((button) => button.textContent === 'Back')!
  act(() => backButton.click())
  expect(useUIStore.getState().showSettings).toBe(false)
  expect(left.querySelector('[aria-label="Settings"]')).not.toBeNull()
  expect((left.querySelector('[data-sidebar-scrollarea]') as HTMLElement).style.width).toBe('0px')
})

it.each(['settings', 'usage'] as const)('keeps %s open when collapsing and reopening the sidebar', (page) => {
  useUIStore.setState({ showSettings: page === 'settings', showUsage: page === 'usage', leftSidebarHidden: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Sidebar />))
  const sidebar = host.querySelector<HTMLElement>('[data-sidebar-scrollarea]')!
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Hide sidebar"]')!.click())
  expect(sidebar.style.width).toBe('0px')
  expect(useUIStore.getState()).toMatchObject({
    showSettings: page === 'settings', showUsage: page === 'usage', leftSidebarHidden: true,
  })
  act(() => useUIStore.getState().setLeftSidebarHidden(false))
  expect(sidebar.style.width).not.toBe('0px')
  expect(useUIStore.getState()).toMatchObject({ showSettings: page === 'settings', showUsage: page === 'usage' })
})
