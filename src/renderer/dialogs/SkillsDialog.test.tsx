import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillsDialog } from './SkillsDialog'
import { useUIStore } from '../stores/uiStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../stores/appStore', () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ workspaces: [], selectedWorkspaceId: '' }) }))
vi.mock('../shells/LeftSidebarReopen', () => ({ LeftSidebarReopen: () => null, useLeftChromeInset: () => 0 }))

let root: Root
let host: HTMLDivElement
let slot: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  slot = document.createElement('div')
  slot.id = 'skills-content-slot'
  document.body.append(host, slot)
  root = createRoot(host)
  Object.assign(window.electronAPI, {
    skillsGetIndex: vi.fn().mockResolvedValue([{ id: 'skill', name: 'Example skill', description: 'A useful skill', tags: [], format: 'skill-md', source: { repo: 'owner/repo', ref: 'main', path: 'skill' }, provenance: 'user', sourceId: '' }]),
    skillsListSaved: vi.fn().mockResolvedValue([]),
    skillsListInstalled: vi.fn().mockResolvedValue([]),
  })
  useUIStore.getState().setShowSkillsDialog(true)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); slot.remove()
  useUIStore.getState().setShowSkillsDialog(false)
  useUIStore.getState().setShowUsage(false)
  useUIStore.getState().closeSettings()
})

it('renders the catalog in the content area without a modal or an open folder', async () => {
  await act(async () => root.render(<SkillsDialog />))
  expect(slot.querySelector('section[aria-label="Skills"]')).not.toBeNull()
  expect(slot.querySelector('h1')?.textContent).toBe('Skills')
  expect(slot.textContent).toContain('Example skill')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(slot.querySelector<HTMLButtonElement>('button[title="Open a folder first"]')?.disabled).toBe(true)
})

it('switches to skills settings and removes the skills page', async () => {
  await act(async () => root.render(<SkillsDialog />))
  const settings = [...slot.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === 'Skill sources & settings')
  expect(settings).toBeDefined()
  await act(async () => settings!.click())
  expect(slot.childElementCount).toBe(0)
  expect(useUIStore.getState()).toMatchObject({ showSkillsDialog: false, showSettings: true, settingsInitialTab: 'skills' })
})

it('opens full screen in a detached window without a content slot', async () => {
  slot.remove()
  await act(async () => root.render(<SkillsDialog />))
  const page = document.querySelector('section[aria-label="Skills"]')!
  expect(page.classList.contains('fixed')).toBe(true)
  await act(async () => page.querySelector<HTMLButtonElement>('header button')!.click())
  expect(useUIStore.getState().showSkillsDialog).toBe(false)
})

it('switches layouts with one button and preserves the search', async () => {
  await act(async () => root.render(<SkillsDialog />))
  const input = slot.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Example')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="Switch to card view"]')!.click())
  expect(slot.querySelector('article')?.classList.contains('flex-col')).toBe(true)
  expect(slot.querySelectorAll('button[aria-label^="Switch to"]')).toHaveLength(1)
  expect(input.value).toBe('Example')
  expect(slot.textContent).toContain('Example skill')
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="Switch to list view"]')!.click())
  expect(slot.querySelector('article')?.classList.contains('flex-col')).toBe(false)
  expect(input.value).toBe('Example')
})

it('groups repositories and lets users open their skills and return in either layout', async () => {
  const entry = (id: string, repo: string) => ({ id, name: id, description: '', tags: [], format: 'skill-md', source: { repo, ref: 'main', path: id }, provenance: 'user', sourceId: '' })
  vi.mocked(window.electronAPI.skillsGetIndex).mockResolvedValue([
    entry('Planning', 'owner/tools'), entry('Review', 'owner/tools'), entry('Design', 'other/design'),
  ] as Awaited<ReturnType<typeof window.electronAPI.skillsGetIndex>>)
  await act(async () => root.render(<SkillsDialog />))
  const clickText = async (label: string) => {
    const button = [...slot.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!
    await act(async () => button.click())
  }
  await clickText('Repositories')
  expect(slot.querySelectorAll('button[aria-label^="Browse "]')).toHaveLength(2)
  expect(slot.textContent).toContain('2 skills')
  expect(slot.querySelectorAll('article')).toHaveLength(0)
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="Browse owner/tools"]')!.click())
  expect([...slot.querySelectorAll('article')].map((row) => row.textContent).join(' ')).toContain('Planning')
  expect(slot.querySelectorAll('article')).toHaveLength(2)
  expect(slot.textContent).not.toContain('Design')
  await clickText('All repositories')
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="Switch to card view"]')!.click())
  expect(slot.querySelector('button[aria-label="Browse owner/tools"]')?.parentElement?.classList.contains('grid')).toBe(true)
  const input = slot.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'owner/tools Review')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(slot.querySelectorAll('button[aria-label^="Browse "]')).toHaveLength(1)
  expect(slot.textContent).toContain('1 matching skill')
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="Browse owner/tools"]')!.click())
  expect(slot.querySelectorAll('article')).toHaveLength(1)
  expect(slot.querySelector('article')?.textContent).toContain('Review')
  await clickText('All skills')
  expect(input.value).toBe('owner/tools Review')
  expect(slot.querySelectorAll('article')).toHaveLength(1)
  expect(slot.textContent).not.toContain('All repositories')
})
