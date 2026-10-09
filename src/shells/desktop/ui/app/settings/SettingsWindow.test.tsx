import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { SettingRow, Toggle } from '../../kernel/interaction'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientSettingsStore } from '@kernel/settings/client'
import { installClientSettings, useClientSetting, setClientSetting } from '../../kernel/settings'
import { SettingsWindow } from './SettingsWindow'
import { registerSettingsPage, resolveSectionId, visiblePages, type SettingsPage } from './registry'
import { SidebarPage } from './pages/clientPages'
import { clientSettingsTable } from '../../../settings'

let host: HTMLDivElement
let root: Root
const stops: (() => void)[] = []

const page = (over: Partial<SettingsPage> & Pick<SettingsPage, 'id' | 'title'>): SettingsPage => ({
  group: 'general',
  scope: 'client',
  component: () => <SettingRow label={`${over.title} row`}><span /></SettingRow>,
  ...over,
})

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const stop of stops.splice(0)) stop()
  installClientSettings(null)
})

describe('settings page registry', () => {
  const pages = [
    page({ id: 'appearance', title: 'Appearance' }),
    page({ id: 'runtime', title: 'Runtime', scope: 'workspace' }),
    page({ id: 'canvas', title: 'Canvas' }),
  ]

  it('shows workspace pages only with a workspace', () => {
    expect(visiblePages(pages, null).map((p) => p.id)).toEqual(['appearance', 'canvas'])
    expect(visiblePages(pages, 'w').map((p) => p.id)).toEqual(['appearance', 'runtime', 'canvas'])
  })

  it('resolves a section by id or title, falling back to the first page', () => {
    expect(resolveSectionId('Runtime', pages)).toBe('runtime')
    expect(resolveSectionId('canvas', pages)).toBe('canvas')
    expect(resolveSectionId('nope', pages)).toBe('appearance')
    expect(resolveSectionId(undefined, pages)).toBe('appearance')
  })
})

describe('SettingsWindow', () => {
  beforeEach(() => {
    stops.push(registerSettingsPage(page({ id: 'appearance', title: 'Appearance' })))
    stops.push(registerSettingsPage(page({ id: 'notifications', title: 'Notifications' })))
    stops.push(registerSettingsPage(page({ id: 'runtime', title: 'Runtime', group: 'workspace', scope: 'workspace' })))
  })

  it('shows only client pages without a workspace', () => {
    act(() => root.render(<SettingsWindow workspaceId={null} onClose={() => {}} />))
    const text = document.body.textContent ?? ''
    expect(text).toContain('Appearance row')
    expect(text).toContain('Notifications row')
    expect(text).not.toContain('Runtime row')
  })

  it("adds the active workspace's pages, marked as workspace settings", () => {
    act(() => root.render(<SettingsWindow workspaceId="local:/p" onClose={() => {}} />))
    const section = document.body.querySelector('[data-section-id="runtime"]')!
    expect(section.textContent).toContain('Runtime row')
    expect(section.textContent).toContain('Workspace')
  })

  it('filters rows by the search and hides empty pages', () => {
    act(() => root.render(<SettingsWindow workspaceId={null} onClose={() => {}} />))
    type(document.body.querySelector('input[type="search"]') as HTMLInputElement, 'notif')
    const appearance = document.body.querySelector('[data-section-id="appearance"]') as HTMLElement
    const notifications = document.body.querySelector('[data-section-id="notifications"]') as HTMLElement
    expect(appearance.hidden).toBe(true)
    expect(notifications.hidden).toBe(false)
  })

  it('clears the search on Escape, then closes', () => {
    const onClose = vi.fn()
    act(() => root.render(<SettingsWindow workspaceId={null} onClose={onClose} />))
    const input = document.body.querySelector('input[type="search"]') as HTMLInputElement
    type(input, 'x')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).not.toHaveBeenCalled()
    expect(input.value).toBe('')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('client settings hooks and pages', () => {
  it('edits a client setting through the installed store', async () => {
    const device = createMemoryDeviceStore()
    const store = createClientSettingsStore(device, clientSettingsTable)
    await store.load()
    installClientSettings(store)
    act(() => root.render(<SidebarPage />))
    const toggles = [...host.querySelectorAll('[role="switch"]')] as HTMLButtonElement[]
    expect(toggles[0].getAttribute('aria-checked')).toBe('true')
    act(() => { toggles[0].click() })
    expect(store.get('showSkillsInWorkspaceOverview')).toBe(false)
    expect(host.querySelectorAll('[role="switch"]')[0].getAttribute('aria-checked')).toBe('false')
  })

  it('re-renders on outside edits', async () => {
    const device = createMemoryDeviceStore()
    const store = createClientSettingsStore(device, clientSettingsTable)
    await store.load()
    installClientSettings(store)
    function Probe() {
      const on = useClientSetting('snapToGrid')
      return <Toggle checked={on} onChange={(v) => setClientSetting('snapToGrid', v)} label="snap" />
    }
    act(() => root.render(<Probe />))
    act(() => device.change('settings', { snapToGrid: true }))
    expect(host.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })
})
