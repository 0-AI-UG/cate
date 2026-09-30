// Test helper: a fake `skills` proxy behind the runtime slot.

import { vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import type { InstalledSkill, SkillEntry, SkillSource, SkillTarget } from '../contract'

export const TARGETS: SkillTarget[] = [
  { id: 'claude-code', label: 'Claude Code', baseSegments: ['.claude', 'skills'], layout: 'folder', bundledResources: true, nameMatchesDir: true },
  { id: 'codex', label: 'Codex', baseSegments: ['.codex', 'skills'], layout: 'folder', bundledResources: true, nameMatchesDir: true },
]

export function entry(id: string, repo = 'owner/repo', extra: Partial<SkillEntry> = {}): SkillEntry {
  return { id, name: id, description: '', tags: [], format: 'skill-md', source: { repo, ref: 'main', path: id }, provenance: 'user', sourceId: '', ...extra }
}

export function installFakeSkills(workspaceId = 'ws', init: { index?: SkillEntry[]; installed?: InstalledSkill[]; sources?: SkillSource[] } = {}) {
  const skills = {
    targets: vi.fn(async () => TARGETS),
    index: vi.fn(async () => init.index ?? []),
    listInstalled: vi.fn(async () => init.installed ?? []),
    install: vi.fn(async ({ entry: e, targetId }: { entry: SkillEntry; targetId: string }) => ({
      installed: { skillId: e.id, name: e.name, targetId, path: `/w/${e.id}`, origin: 'local' as const },
      warnings: [] as string[],
    })),
    uninstall: vi.fn(async () => ({ warnings: [] as string[] })),
    listSources: vi.fn(async () => init.sources ?? []),
    addSource: vi.fn(async ({ repo }: { repo: string }) => ({ id: repo, repo })),
    removeSource: vi.fn(async () => {}),
  }
  const runtime = { skills } as unknown as RuntimeProxy
  const remove = setRuntimeResolver((id) => (id === workspaceId ? runtime : null))
  return { skills, remove }
}
