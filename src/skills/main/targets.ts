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

import { hostJoin, PI_AGENT_DIR } from '../../agent/main/agentDir'
import { agentForSkillTarget } from '../../shared/agents'
import { getSkillTarget, type SkillTargetId, type SkillTargetInfo } from '../../shared/skills'

/** Workspace-relative segments for a target's skills root. Every agent CLI
 *  declares its own on AgentDef.skills (src/shared/agents.ts) — this resolves
 *  through the registry so there is no second dir table to keep in sync. Only
 *  `cate-agent` is spelled out: it is Cate's own panel, not an agent CLI, and
 *  its root needs PI_AGENT_DIR from the main process. */
function baseSegments(targetId: SkillTargetId): readonly string[] {
  if (targetId === 'cate-agent') return ['.cate', PI_AGENT_DIR, 'skills']
  const skills = agentForSkillTarget(targetId)?.skills
  // Unreachable: SkillTargetId is exactly cate-agent + the agent-declared ids.
  if (!skills) throw new Error(`No skills root declared for target: ${targetId}`)
  return skills.baseSegments
}

/** Host path to a target's skills root under the workspace. */
export function skillsRootDir(targetId: SkillTargetId, runtimeId: string, hostCwd: string): string {
  return hostJoin(runtimeId, hostCwd, ...baseSegments(targetId))
}

/** The target's top-level tool dir under the workspace root (e.g. `.claude`,
 *  `.codex`) — its presence is the signal that the agent is used there. */
export function toolDirSegment(targetId: SkillTargetId): string {
  return baseSegments(targetId)[0]
}

export function targetInfo(targetId: SkillTargetId): SkillTargetInfo {
  return getSkillTarget(targetId)
}
