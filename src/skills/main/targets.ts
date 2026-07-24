// =============================================================================
// Skill target adapters (main-process).
//
// Each coding agent discovers skills from a different per-project directory, but
// all follow the open Agent Skills standard (a `SKILL.md` folder). So an adapter
// is mostly just its workspace-relative base dir; the install engine
// (skillsInstaller.ts) handles the shared folder/flat write logic.
//
// Paths are always WORKSPACE-relative — built on the host that runs the agent
// (local native separators, remote POSIX) via `hostJoin`. See skillsInstaller
// for the write logic.
// =============================================================================

import { hostJoin } from '../../cateAgent/main/codingDir'
import { agentForSkillTarget } from '../../shared/agents'
import { getSkillTarget, type SkillTargetId, type SkillTargetInfo } from '../../shared/skills'

/** Workspace-relative segments for a target's skills root. Every external or
 *  embedded agent declares its own on the integration registry. */
function baseSegments(targetId: SkillTargetId): readonly string[] {
  const skills = agentForSkillTarget(targetId)?.skills
  // Unreachable: SkillTargetId is exactly the integration-declared ids.
  if (!skills) throw new Error(`No skills root declared for target: ${targetId}`)
  return skills.baseSegments
}

function allBaseSegments(targetId: SkillTargetId): readonly (readonly string[])[] {
  const skills = agentForSkillTarget(targetId)?.skills
  if (!skills) throw new Error(`No skills root declared for target: ${targetId}`)
  return [skills.baseSegments, ...(skills.mirrorBaseSegments ?? [])]
}

/** Host path to a target's skills root under the workspace. */
export function skillsRootDir(targetId: SkillTargetId, runtimeId: string, hostCwd: string): string {
  return hostJoin(runtimeId, hostCwd, ...baseSegments(targetId))
}

/** Every host root that must receive a target's bundle. The first root is the
 *  canonical, manifest-tracked install; later roots are transparent consumers
 *  of the same integration target. */
export function skillsRootDirs(targetId: SkillTargetId, runtimeId: string, hostCwd: string): string[] {
  return allBaseSegments(targetId).map((segments) => hostJoin(runtimeId, hostCwd, ...segments))
}

/** The target's top-level tool dir under the workspace root (e.g. `.claude`,
 *  `.codex`) — its presence is the signal that the agent is used there. */
export function toolDirSegment(targetId: SkillTargetId): string {
  return baseSegments(targetId)[0]
}

export function targetInfo(targetId: SkillTargetId): SkillTargetInfo {
  return getSkillTarget(targetId)
}
