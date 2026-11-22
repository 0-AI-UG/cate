import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '../../../../../test/clientUi'
import { SkillsDialog } from './SkillsDialog'
import { entry, installFakeSkills } from '../../../../../test/skillsRuntime'

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

it('renders the catalog in a dialog', async () => {
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} />))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog).not.toBeNull()
  expect(dialog.textContent).toContain('Skills')
  expect(dialog.textContent).toContain('Example skill')
})

it('disables install without an open workspace', async () => {
  await act(async () => root.render(<SkillsDialog workspaceId={null} onClose={() => {}} />))
  expect(document.body.textContent).toContain('Open a workspace to browse skills.')
})

it('closes and opens skills settings from the gear', async () => {
  const onClose = vi.fn()
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={onClose} />))
  const settings = buttons().find((b) => b.getAttribute('aria-label') === 'Skill sources & settings')!
  await act(async () => settings.click())
  expect(onClose).toHaveBeenCalled()
  expect(ui.openSettings).toHaveBeenCalledWith('skills')
})

it('closes with Escape', async () => {
  const onClose = vi.fn()
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={onClose} />))
  expect(document.querySelector('[role="dialog"][aria-label="Skills"]')).not.toBeNull()
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('switches layouts with one button and preserves the search', async () => {
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} />))
  const input = document.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Example')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Card view"]')!.click())
  expect(document.querySelector('article')?.classList.contains('flex-col')).toBe(true)
  expect(document.querySelectorAll('button[aria-label="Card view"], button[aria-label="List view"]')).toHaveLength(1)
  expect(input.value).toBe('Example')
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click())
  expect(document.querySelector('article')?.classList.contains('flex-col')).toBe(false)
})

it('groups repositories and lets users open their skills and return', async () => {
  fake.skills.index.mockResolvedValue([entry('Planning', 'owner/tools'), entry('Review', 'owner/tools'), entry('Design', 'other/design')])
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} />))
  const clickText = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!
    await act(async () => button.click())
  }
  await clickText('Repositories')
  expect(document.querySelectorAll('button[aria-label^="Browse "]')).toHaveLength(2)
  expect(document.body.textContent).toContain('2 skills')
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Browse owner/tools"]')!.click())
  expect(document.querySelectorAll('article')).toHaveLength(2)
  expect(document.body.textContent).not.toContain('Design')
  await clickText('All repositories')
  expect(document.querySelectorAll('button[aria-label^="Browse "]')).toHaveLength(2)
})

it('installs through the agent menu and updates installed copies per target', async () => {
  fake.skills.listInstalled.mockResolvedValue([{ skillId: 'Example skill', name: 'Example skill', targetId: 'codex', path: '/w/.codex/skills/x/SKILL.md', origin: 'local' }])
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} />))
  expect(document.body.textContent).toContain('Installed · 1')
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
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} />))
  const install = buttons().find((b) => b.textContent?.startsWith('Install'))!
  vi.spyOn(install, 'getBoundingClientRect').mockReturnValue({ bottom: 10, left: 10 } as DOMRect)
  await act(async () => install.click())
  await act(async () => buttons().find((b) => b.textContent === 'Claude Code')!.click())
  expect(document.body.textContent).toContain('disk full')
})


it('waits for the selected workspace’s runtime instead of asking to open a workspace', async () => {
  await act(async () => root.render(<SkillsDialog workspaceId="connecting" onClose={() => {}} />))
  expect(document.body.textContent).toContain('Loading skills')
  expect(document.body.textContent).not.toContain('Open a workspace to browse skills.')
  expect(document.body.textContent).not.toContain('No catalog yet')
})

it('shows a catalog error without claiming the catalog is empty', async () => {
  fake.skills.index.mockRejectedValue(new Error('Runtime unavailable'))
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} />))
  expect(document.body.textContent).toContain('Runtime unavailable')
  expect(document.body.textContent).not.toContain('No catalog yet')
})

it('clears a catalog failure when refreshing succeeds', async () => {
  fake.skills.index.mockRejectedValueOnce(new Error('Runtime unavailable'))
  await act(async () => root.render(<SkillsDialog workspaceId="ws" onClose={() => {}} />))
  expect(document.body.textContent).toContain('Runtime unavailable')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh catalog"]')!.click())
  expect(document.body.textContent).toContain('Example skill')
  expect(document.body.textContent).not.toContain('Runtime unavailable')
})
