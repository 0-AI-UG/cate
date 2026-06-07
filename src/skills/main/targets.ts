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

import { hostJoin } from '../../agent/main/agentDir'
import { getSkillTarget, type SkillTargetId, type SkillTargetInfo } from '../../shared/skills'

/** Workspace-relative segments for each target's skills root. */
const BASE_SEGMENTS: Record<SkillTargetId, string[]> = {
  'claude-code': ['.claude', 'skills'],
  'cate-agent': ['.cate', 'pi-agent', 'skills'],
  // `.agents/skills` is the cross-tool shared location pi (and others) read.
  'pi-native': ['.agents', 'skills'],
  'opencode': ['.opencode', 'skills'],
  'codex': ['.codex', 'skills'],
  'antigravity': ['.agent', 'skills'],
}

/** Host path to a target's skills root under the workspace. */
export function skillsRootDir(targetId: SkillTargetId, companionId: string, hostCwd: string): string {
  return hostJoin(companionId, hostCwd, ...BASE_SEGMENTS[targetId])
}

export function targetInfo(targetId: SkillTargetId): SkillTargetInfo {
  return getSkillTarget(targetId)
}
