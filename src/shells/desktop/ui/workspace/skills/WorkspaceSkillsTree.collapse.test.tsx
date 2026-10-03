// Skills tree collapse state must outlive the component: the tree unmounts
// whenever the workspace row folds.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTreeCollapseStore } from '../files'
import type { InstalledSkill } from '@workspace/skills/contract'
import { WorkspaceSkillsTree } from './WorkspaceSkillsTree'
import { installFakeSkills } from './testRuntime'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROWS: InstalledSkill[] = [
  { skillId: 'cate-cli', name: 'cate-cli', targetId: 'claude-code', path: '/w/.claude/skills/cate-cli/SKILL.md', origin: 'local' },
]

let host: HTMLDivElement
let root: Root
let removers: (() => void)[]

beforeEach(() => {
  localStorage.clear()
  useTreeCollapseStore.setState({ collapsed: new Set() })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  removers = []
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  for (const remove of removers) remove()
})

function fake(workspaceId: string) {
  const f = installFakeSkills(workspaceId, { installed: ROWS })
  removers.push(f.remove)
  return f
}

async function mount(workspaceId = 'w1', enabled = true): Promise<void> {
  await act(async () => {
    root.render(<WorkspaceSkillsTree workspaceId={workspaceId} enabled={enabled} onOpenSkills={() => {}} />)
  })
}

const rowTitles = (): string[] => [...host.querySelectorAll('button')].map((b) => b.textContent ?? '')

const clickRow = (label: string): void => {
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function remount(workspaceId = 'w1'): Promise<void> {
  act(() => { root.render(<></>) })
  await mount(workspaceId)
}

describe('WorkspaceSkillsTree collapse persistence', () => {
  it('does not load or show skills when the overview setting is disabled', async () => {
    const { skills } = fake('w1')
    await mount('w1', false)
    expect(skills.listInstalled).not.toHaveBeenCalled()
    expect(rowTitles()).toEqual([])
  })

  it('labels agents with the runtime targets and opens the skills view', async () => {
    fake('w1')
    let opened = 0
    await act(async () => {
      root.render(<WorkspaceSkillsTree workspaceId="w1" enabled onOpenSkills={() => { opened++ }} />)
    })
    expect(rowTitles()).toEqual(['Skills', 'Claude Code', 'cate-cli'])
    clickRow('cate-cli')
    expect(opened).toBe(1)
  })

  it('keeps an agent group collapsed across a remount', async () => {
    fake('w1')
    await mount()
    expect(rowTitles()).toContain('cate-cli')
    clickRow('Claude Code')
    expect(rowTitles()).not.toContain('cate-cli')
    await remount()
    expect(rowTitles()).toContain('Claude Code')
    expect(rowTitles()).not.toContain('cate-cli')
  })

  it('keeps the Skills node collapsed across a remount', async () => {
    fake('w1')
    await mount()
    clickRow('Skills')
    expect(rowTitles()).not.toContain('Claude Code')
    await remount()
    expect(rowTitles()).toEqual(['Skills'])
  })

  it('scopes collapse state per workspace', async () => {
    fake('w1')
    await mount('w1')
    clickRow('Claude Code')
    removers.pop()?.()
    fake('w2')
    await remount('w2')
    expect(rowTitles()).toContain('cate-cli')
  })
})
