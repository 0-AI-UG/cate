import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILLS_INSTALL, SKILLS_UNINSTALL } from '../../shared/ipc-channels'
import type { SkillEntry } from '../../shared/skills'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  install: vi.fn(),
  uninstall: vi.fn(),
  worktreeList: vi.fn(),
  sync: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler)
    }),
  },
}))
vi.mock('../../main/logger', () => ({ default: { warn: vi.fn() } }))
vi.mock('../../main/windowRegistry', () => ({ windowFromEvent: () => ({ id: 9 }) }))
vi.mock('../../main/runtime/runtimeManager', () => ({
  runtimes: {
    resolve: () => ({ vcs: { worktreeList: state.worktreeList } }),
  },
}))
vi.mock('./skillsInstaller', () => ({
  install: state.install,
  uninstall: state.uninstall,
  listInstalled: vi.fn(),
  saveSkill: vi.fn(),
  unsaveSkill: vi.fn(),
}))
vi.mock('./skillsMirror', () => ({ syncWorkspaceSkills: state.sync }))
vi.mock('./skillsRegistry', () => ({
  getMergedIndex: vi.fn(),
  refresh: vi.fn(),
  getPreview: vi.fn(),
}))
vi.mock('./savedSkills', () => ({ listSaved: vi.fn() }))
vi.mock('./skillSources', () => ({
  listSources: vi.fn(),
  addSource: vi.fn(),
  removeSource: vi.fn(),
  getToken: vi.fn(),
  setToken: vi.fn(),
}))

import { registerSkillHandlers } from './ipcSkills'

const entry: SkillEntry = {
  id: 'owner/repo/demo',
  name: 'Demo',
  description: 'demo',
  tags: [],
  format: 'skill-md',
  source: { repo: 'owner/repo', ref: 'main', path: 'skills/demo' },
  provenance: 'curated',
  sourceId: 'owner/repo',
}

describe('skill mutation worktree propagation', () => {
  beforeEach(() => {
    state.handlers.clear()
    state.install.mockReset().mockResolvedValue({
      installed: {
        skillId: entry.id,
        name: entry.name,
        targetId: 'codex',
        path: '/repo/.codex/skills/demo/SKILL.md',
        origin: 'local',
      },
      warnings: [],
    })
    state.uninstall.mockReset().mockResolvedValue(undefined)
    state.worktreeList.mockReset().mockResolvedValue([
      { path: '/repo', branch: 'main', isBare: false },
      { path: '/repo/.cate/worktrees/feature', branch: 'feature', isBare: false },
      { path: '/repo.git', branch: '(unknown)', isBare: true },
    ])
    state.sync.mockReset().mockImplementation(async (_base: string, target: string) => ({
      copied: [],
      updated: [],
      removed: [],
      preserved: [],
      warnings: target.includes('feature') ? ['mirror warning'] : [],
    }))
    registerSkillHandlers()
  })

  it('propagates an install to every non-bare worktree under the workspace scope', async () => {
    const result = await state.handlers.get(SKILLS_INSTALL)!(
      {},
      entry,
      'codex',
      '/repo',
      'workspace-1',
    )

    expect(state.worktreeList).toHaveBeenCalledWith('/repo', {
      ownerWindowId: 9,
      scopeId: 'workspace-1',
    })
    expect(state.sync).toHaveBeenCalledWith('/repo', '/repo')
    expect(state.sync).toHaveBeenCalledWith('/repo', '/repo/.cate/worktrees/feature')
    expect(state.sync).not.toHaveBeenCalledWith('/repo', '/repo.git')
    expect(result).toMatchObject({ ok: true, warnings: ['mirror warning'] })
  })

  it('propagates an uninstall so unchanged mirrors are retired immediately', async () => {
    await state.handlers.get(SKILLS_UNINSTALL)!(
      {},
      entry.id,
      entry.name,
      'codex',
      '/repo',
      'workspace-1',
    )

    expect(state.uninstall).toHaveBeenCalledWith(entry.id, entry.name, 'codex', '/repo')
    expect(state.sync).toHaveBeenCalledWith('/repo', '/repo/.cate/worktrees/feature')
  })
})
