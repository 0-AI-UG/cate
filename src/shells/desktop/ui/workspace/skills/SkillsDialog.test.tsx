import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/interaction/testing'
import { SkillsDialog } from './SkillsDialog'
import { entry, installFakeSkills } from './testRuntime'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let slot: HTMLDivElement
let ui: ReturnType<typeof installMockClientUi>
let fake: ReturnType<typeof installFakeSkills>

beforeEach(() => {
  host = document.createElement('div')
  slot = document.createElement('div')
  document.body.append(host, slot)
  root = createRoot(host)
  ui = installMockClientUi()
  fake = installFakeSkills('ws', { index: [entry('Example skill', 'owner/repo', { description: 'A useful skill' })] })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); slot.remove()
  fake.remove()
})

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]

it('renders the catalog in the content area without a modal', async () => {
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} container={slot} />))
  expect(slot.querySelector('section[aria-label="Skills"]')).not.toBeNull()
  expect(slot.querySelector('h1')?.textContent).toBe('Skills')
  expect(slot.textContent).toContain('Example skill')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('disables install without an open workspace', async () => {
  await act(async () => root.render(<SkillsDialog workspaceId={null} onClose={() => {}} container={slot} />))
  expect(slot.textContent).toContain('Open a folder to browse skills.')
})

it('uses the host header chrome when given', async () => {
  await act(async () => root.render(
    <SkillsDialog workspaceId="ws" onClose={() => {}} container={slot} renderHeader={(actions) => <div data-testid="chrome">{actions}</div>} />,
  ))
  expect(slot.querySelector('[data-testid="chrome"]')?.textContent).toContain('Add a skill source')
  expect(slot.querySelector('h1')).toBeNull()
})

it('closes and opens skills settings from the gear', async () => {
  const onClose = vi.fn()
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={onClose} container={slot} />))
  const settings = buttons().find((b) => b.getAttribute('aria-label') === 'Skill sources & settings')!
  await act(async () => settings.click())
  expect(onClose).toHaveBeenCalled()
  expect(ui.openSettings).toHaveBeenCalledWith('skills')
})

it('opens full screen without a container, with a Back button and Escape', async () => {
  const onClose = vi.fn()
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={onClose} />))
  const page = document.querySelector('section[aria-label="Skills"]')!
  expect(page.classList.contains('fixed')).toBe(true)
  await act(async () => page.querySelector<HTMLButtonElement>('header button')!.click())
  expect(onClose).toHaveBeenCalledTimes(1)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(onClose).toHaveBeenCalledTimes(2)
})

it('switches layouts with one button and preserves the search', async () => {
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} container={slot} />))
  const input = slot.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Example')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="Card view"]')!.click())
  expect(slot.querySelector('article')?.classList.contains('flex-col')).toBe(true)
  expect(slot.querySelectorAll('button[aria-label="Card view"], button[aria-label="List view"]')).toHaveLength(1)
  expect(input.value).toBe('Example')
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click())
  expect(slot.querySelector('article')?.classList.contains('flex-col')).toBe(false)
})

it('groups repositories and lets users open their skills and return', async () => {
  fake.skills.index.mockResolvedValue([entry('Planning', 'owner/tools'), entry('Review', 'owner/tools'), entry('Design', 'other/design')])
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} container={slot} />))
  const clickText = async (label: string) => {
    const button = [...slot.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!
    await act(async () => button.click())
  }
  await clickText('Repositories')
  expect(slot.querySelectorAll('button[aria-label^="Browse "]')).toHaveLength(2)
  expect(slot.textContent).toContain('2 skills')
  await act(async () => slot.querySelector<HTMLButtonElement>('button[aria-label="Browse owner/tools"]')!.click())
  expect(slot.querySelectorAll('article')).toHaveLength(2)
  expect(slot.textContent).not.toContain('Design')
  await clickText('All repositories')
  expect(slot.querySelectorAll('button[aria-label^="Browse "]')).toHaveLength(2)
})

it('installs through the agent menu and updates installed copies per target', async () => {
  fake.skills.listInstalled.mockResolvedValue([{ skillId: 'Example skill', name: 'Example skill', targetId: 'codex', path: '/w/.codex/skills/x/SKILL.md', origin: 'local' }])
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} container={slot} />))
  expect(slot.textContent).toContain('Installed · 1')
  const update = buttons().find((b) => b.getAttribute('aria-label') === 'Update installed copies from source')!
  await act(async () => update.click())
  expect(fake.skills.install).toHaveBeenCalledWith({ entry: expect.objectContaining({ id: 'Example skill' }), targetId: 'codex' })

  const agents = buttons().find((b) => b.textContent?.startsWith('Agents'))!
  vi.spyOn(agents, 'getBoundingClientRect').mockReturnValue({ bottom: 10, left: 10 } as DOMRect)
  await act(async () => agents.click())
  const codex = buttons().find((b) => b.textContent === 'Codex')!
  expect(codex.title).toBe('Uninstall skill')
  await act(async () => codex.click())
  expect(fake.skills.uninstall).toHaveBeenCalledWith({ skillId: 'Example skill', targetId: 'codex' })
})

it('shows an install failure', async () => {
  fake.skills.install.mockRejectedValue(new Error('disk full'))
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} container={slot} />))
  const install = buttons().find((b) => b.textContent?.startsWith('Install'))!
  vi.spyOn(install, 'getBoundingClientRect').mockReturnValue({ bottom: 10, left: 10 } as DOMRect)
  await act(async () => install.click())
  await act(async () => buttons().find((b) => b.textContent === 'Claude Code')!.click())
  expect(slot.textContent).toContain('disk full')
})
