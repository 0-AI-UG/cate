// =============================================================================
// Regression test: skills-tree collapse state must outlive the component.
//
// WorkspaceSkillsTree renders inside WorkspaceTab's `isExpanded &&` block, so
// folding the workspace row unmounts it. When the collapse state lived in local
// useState, every fold (and every restart) silently re-expanded the Skills node
// and every agent group. It now lives in the persisted treeCollapse store.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { InstalledSkill } from '../../shared/skills'
import { WorkspaceSkillsTree } from './WorkspaceSkillsTree'
import { useTreeCollapseStore } from './treeCollapse'

const ROWS: InstalledSkill[] = [
  { skillId: 'cate-cli', name: 'cate-cli', targetId: 'claude-code', path: '/w/.claude/skills/cate-cli/SKILL.md', origin: 'local' },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  useTreeCollapseStore.setState({ collapsed: new Set() })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.electronAPI.skillsListInstalled = vi.fn().mockResolvedValue(ROWS)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

/** Mount the tree and let the async skillsListInstalled effect settle. */
async function mount(workspaceId = 'w1'): Promise<void> {
  await act(async () => {
    root.render(<WorkspaceSkillsTree workspaceId={workspaceId} rootPath="/w" />)
  })
}

const rowTitles = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => b.textContent ?? '')

const clickRow = (label: string): void => {
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Simulate the workspace row folding and reopening. */
async function remount(workspaceId = 'w1'): Promise<void> {
  act(() => { root.render(<></>) })
  await mount(workspaceId)
}

describe('WorkspaceSkillsTree collapse persistence', () => {
  it('keeps an agent group collapsed across a remount', async () => {
    await mount()
    expect(rowTitles()).toContain('cate-cli')

    clickRow('Claude Code')
    expect(rowTitles()).not.toContain('cate-cli')

    await remount()
    expect(rowTitles()).toContain('Claude Code')
    expect(rowTitles()).not.toContain('cate-cli')
  })

  it('keeps the Skills node collapsed across a remount', async () => {
    await mount()
    clickRow('Skills')
    expect(rowTitles()).not.toContain('Claude Code')

    await remount()
    expect(rowTitles()).toEqual(['Skills'])
  })

  it('scopes collapse state per workspace', async () => {
    await mount('w1')
    clickRow('Claude Code')

    await remount('w2')
    expect(rowTitles()).toContain('cate-cli')
  })

  it('restores collapse state written by a previous session', async () => {
    localStorage.setItem('cate.sidebar.treeCollapsed', JSON.stringify(['w1:skills:claude-code']))
    useTreeCollapseStore.setState({ collapsed: new Set(['w1:skills:claude-code']) })

    await mount('w1')
    expect(rowTitles()).toContain('Claude Code')
    expect(rowTitles()).not.toContain('cate-cli')
  })
})
