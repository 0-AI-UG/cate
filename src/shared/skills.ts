// =============================================================================
// Cross-agent skills — shared types + the target table.
//
// Cate installs skills (the open Agent Skills standard: a `SKILL.md` folder with
// `name`/`description` frontmatter + optional scripts/references/assets) into
// several coding agents that share a project. Everything Cate writes lands in the
// opened workspace (each agent's per-target dir) or in Cate's own userData — never
// in another agent's user-home dir.
//
// Two homes for a skill:
//   - saved:     cached in Cate's userData library (skillStore bytes + a
//                saved-skills.json entry). A personal library, in no workspace.
//   - installed: written into a workspace's per-target dir for one agent,
//                recorded in <ws>/.cate/skills.json. Always explicit.
// Saving never touches a workspace; a skill reaches a workspace only when the
// user installs / adds it there.
// =============================================================================

export type SkillTargetId =
  | 'claude-code'
  | 'cate-agent'
  | 'pi-native'
  | 'opencode'
  | 'codex'
  | 'antigravity'

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

/** Static target metadata, shared by main (path/write logic) and renderer (the
 *  install matrix). Workspace-relative base dirs live in `src/skills/main/targets.ts`. */
export const SKILL_TARGETS: readonly SkillTargetInfo[] = [
  { id: 'claude-code', label: 'Claude Code', layout: 'folder', bundledResources: true, nameMatchesDir: true },
  { id: 'cate-agent', label: 'Cate Agent', layout: 'folder', bundledResources: true, nameMatchesDir: false },
  { id: 'pi-native', label: 'Pi', layout: 'folder', bundledResources: true, nameMatchesDir: false },
  { id: 'opencode', label: 'OpenCode', layout: 'folder', bundledResources: true, nameMatchesDir: false },
  { id: 'codex', label: 'Codex', layout: 'folder', bundledResources: true, nameMatchesDir: false },
  { id: 'antigravity', label: 'Antigravity', layout: 'folder', bundledResources: true, nameMatchesDir: false, beta: true },
]

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
