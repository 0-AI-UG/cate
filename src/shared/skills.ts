// =============================================================================
// Cross-agent skills — shared types + the target table.
//
// Cate installs skills (the open Agent Skills standard: a `SKILL.md` folder with
// `name`/`description` frontmatter + optional scripts/references/assets) into
// several coding agents that share a project. Everything Cate writes lands in the
// opened workspace (each agent's per-target dir) or in Cate's own userData — never
// in another agent's user-home dir.
//
// The per-agent half of this file is DERIVED from the canonical agent registry
// (src/shared/agents.ts): each AgentDef declares its own skills dir + layout,
// and SKILL_TARGETS projects them. Adding an agent CLI target means editing
// agents.ts, not this file (beyond widening SkillTargetId).
//
// Two homes for a skill:
//   - saved:     cached in Cate's userData library (skillStore bytes + a
//                saved-skills.json entry). A personal library, in no workspace.
//   - installed: written into a workspace's per-target dir for one agent,
//                recorded in <ws>/.cate/skills.json. Always explicit.
// Saving never touches a workspace; a skill reaches a workspace only when the
// user installs / adds it there.
// =============================================================================

import { AGENTS } from './agents'

/** Stable, PERSISTED target ids (recorded per install in a workspace's
 *  `.cate/skills.json`) — renaming one orphans existing installs.
 *
 *  Every id except `cate-agent` belongs to an agent CLI and is declared on that
 *  agent in src/shared/agents.ts (AgentDef.skills), which is where a NEW target
 *  is added: SKILL_TARGETS below is derived from AGENTS, so the only thing to
 *  do here is widen this union. `cate-agent` is Cate's own agent panel, not a
 *  CLI, so it has no AgentDef and is defined here. */
export type SkillTargetId =
  | 'claude-code'
  | 'cate-agent'
  | 'pi-native'
  | 'opencode'
  | 'codex'
  | 'cursor'
  | 'grok'

/** Where a skill lives in a source repo: the directory that contains its
 *  `SKILL.md` (path === '' means the repo root is the skill dir). */
export interface SkillSourceRef {
  /** "owner/name". */
  repo: string
  /** Branch / tag / sha. */
  ref: string
  /** Dir within the repo holding SKILL.md ('' = repo root). */
  path: string
}

/** One searchable catalog entry (from the curated index or a live user crawl). */
export interface SkillEntry {
  /** Stable id: `${sourceId}/${slug}`. */
  id: string
  name: string
  description: string
  tags: string[]
  format: 'skill-md'
  source: SkillSourceRef
  stars?: number
  updatedAt?: string
  provenance: 'curated' | 'user'
  sourceId: string
  /** True for Cate's own skills (from a `firstParty` source) — pinned to the top
   *  of the skills catalog. Absent for third-party entries. */
  firstParty?: boolean
}

/** A user-added repo to live-crawl (in addition to the curated index). */
export interface SkillSource {
  id: string
  /** "owner/name". */
  repo: string
  ref?: string
  path?: string
}

/** An install recorded in a workspace's `.cate/skills.json`. */
export interface InstalledSkill {
  skillId: string
  name: string
  targetId: SkillTargetId
  /** Locator path to the installed SKILL.md (or flat .md) — for display / open. */
  path: string
  /** Always `local` now — every workspace install is user-driven. */
  origin: 'local'
}

/** A skill saved to the user's Cate library. The canonical bytes live in the
 *  userData skill store keyed by `skillId`; this is the metadata used to list it
 *  and to (re)install it into a workspace without re-fetching. */
export interface SavedSkill {
  skillId: string
  name: string
  description: string
  source: SkillSourceRef
  stars?: number
}

/** Presentation + layout metadata for one install target. For agent CLIs this
 *  is projected from AgentDef.skills (see SKILL_TARGETS). */
export interface SkillTargetInfo {
  id: SkillTargetId
  label: string
  /** `folder` = `<base>/<name>/SKILL.md` (+ bundled files); `flat` = `<base>/<name>.md`. */
  layout: 'folder' | 'flat'
  bundledResources: boolean
  /** The standard requires the frontmatter `name` to equal the dir name. We always
   *  satisfy this (dir = name = slug), so it's informational. */
  nameMatchesDir: boolean
  /** Path not yet fully verified against the tool's current docs. */
  beta?: boolean
}

/** Cate's own agent panel — the one target with no agent CLI behind it, so it
 *  is the one target not derived from AGENTS. Its skills root needs the main
 *  process's PI_AGENT_DIR, so that path lives in `src/skills/main/targets.ts`. */
const CATE_AGENT_TARGET: SkillTargetInfo = {
  id: 'cate-agent',
  label: 'Agent',
  layout: 'folder',
  bundledResources: true,
  nameMatchesDir: false,
}

/** Static target metadata, shared by main (path/write logic) and renderer (the
 *  install matrix). DERIVED from the agent registry — to add a target, declare
 *  `skills` on the agent in src/shared/agents.ts; nothing here changes.
 *  Workspace-relative base dirs live in `src/skills/main/targets.ts`. */
export const SKILL_TARGETS: readonly SkillTargetInfo[] = [
  ...AGENTS.flatMap((a) =>
    a.skills
      ? [{
          id: a.skills.targetId,
          label: a.skills.label ?? a.displayName,
          layout: a.skills.layout,
          bundledResources: a.skills.bundledResources,
          nameMatchesDir: a.skills.nameMatchesDir,
          ...(a.skills.beta ? { beta: true as const } : {}),
        }]
      : [],
  ),
  CATE_AGENT_TARGET,
]

const SKILL_TARGET_IDS: ReadonlySet<string> = new Set(SKILL_TARGETS.map((t) => t.id))

/** Whether a target id is still supported. Persisted data (a workspace's
 *  `.cate/skills.json`) can name a target from an older Cate — `antigravity`
 *  was a target until agent support for it was dropped — so anything read back
 *  from disk must be checked before it reaches code that assumes a live target
 *  (getSkillTarget throws, and skillsRootDir has no dir for it). */
export function isKnownSkillTarget(id: string): id is SkillTargetId {
  return SKILL_TARGET_IDS.has(id)
}

export function getSkillTarget(id: SkillTargetId): SkillTargetInfo {
  const t = SKILL_TARGETS.find((x) => x.id === id)
  if (!t) throw new Error(`Unknown skill target: ${id}`)
  return t
}

/** Lowercase, hyphenated, regex-safe across every target (OpenCode is strictest:
 *  `^[a-z0-9]+(-[a-z0-9]+)*$`). Doubles as the dir name and the frontmatter name. */
export function slugifySkillName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return s || 'skill'
}
