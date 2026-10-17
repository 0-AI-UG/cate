import path from 'node:path'
import type { SkillTarget, SkillTargetId } from '../contract'

/** Lookups over the targets the composition root passed in. */
export interface TargetTable {
  readonly list: readonly SkillTarget[]
  /** Persisted data can name a target this version no longer has. */
  isKnown(id: unknown): id is SkillTargetId
  get(id: SkillTargetId): SkillTarget
  /** Every root that receives a target's bundle. The first is the canonical,
   *  manifest-tracked install; later ones consume the same bundle. */
  rootDirs(id: SkillTargetId, cwd: string): string[]
  /** The agent's tool dir (`.claude`, `.codex`); its presence says the agent
   *  is used in the workspace. */
  toolDir(id: SkillTargetId, cwd: string): string
}

export function createTargetTable(targets: readonly SkillTarget[]): TargetTable {
  const byId = new Map(targets.map((target) => [target.id, target]))
  const get = (id: SkillTargetId): SkillTarget => {
    const target = byId.get(id)
    if (!target) throw new Error(`Unknown skill target: ${id}`)
    return target
  }
  return {
    list: targets,
    isKnown: (id): id is SkillTargetId => typeof id === 'string' && byId.has(id),
    get,
    rootDirs: (id, cwd) => {
      const target = get(id)
      return [target.baseSegments, ...(target.mirrorBaseSegments ?? [])].map((segments) => path.join(cwd, ...segments))
    },
    toolDir: (id, cwd) => path.join(cwd, get(id).baseSegments[0]),
  }
}
