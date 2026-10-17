// Skills: shared types. Cate installs skills (the open Agent Skills standard: a
// `SKILL.md` folder with `name`/`description` frontmatter plus optional
// scripts, references and assets) into the workspace's agent directories and
// records each install in `<root>/.cate/skills.json`. Pure.

/** Stable, persisted target id (recorded per install in `.cate/skills.json`).
 *  The ids come from the agent registry; renaming one orphans its installs. */
export type SkillTargetId = string

/** One install target: where an agent reads project skills from. The
 *  composition root derives these from the agent registry and hands them to
 *  the runtime as data. */
export interface SkillTarget {
  id: SkillTargetId
  label: string
  /** Workspace-relative segments of the skills root (`['.claude', 'skills']`).
   *  The first segment is the agent's tool dir: its presence says the agent is
   *  used in this workspace. */
  baseSegments: readonly string[]
  /** More roots that consume the same bundle (not separate targets). */
  mirrorBaseSegments?: readonly (readonly string[])[]
  /** `folder` = `<base>/<name>/SKILL.md` (+ bundled files); `flat` = `<base>/<name>.md`. */
  layout: 'folder' | 'flat'
  bundledResources: boolean
  nameMatchesDir: boolean
  beta?: boolean
}

/** Where a skill lives in a source repo: the directory that holds its SKILL.md
 *  (`path === ''` means the repo root). */
export interface SkillSourceRef {
  /** "owner/name". */
  repo: string
  ref: string
  path: string
}

/** One catalog entry: the curated index, a crawled workspace source or a skill
 *  bundled with the runtime. */
export interface SkillEntry {
  /** `${sourceId}/${slug}`. */
  id: string
  name: string
  description: string
  tags: string[]
  format: 'skill-md'
  source: SkillSourceRef
  stars?: number
  updatedAt?: string
  provenance: 'curated' | 'user' | 'bundled'
  sourceId: string
  /** Cate's own skills, pinned to the top of the catalog. */
  firstParty?: boolean
}

/** A workspace skill source: a repo to crawl on top of the curated index. */
export interface SkillSource {
  id: string
  /** "owner/name". */
  repo: string
  ref?: string
  path?: string
}

/** An install recorded in `<root>/.cate/skills.json`. */
export interface InstalledSkill {
  skillId: string
  name: string
  targetId: SkillTargetId
  /** Path of the installed SKILL.md (or flat .md) on the runtime's machine. */
  path: string
  origin: 'local'
  /** Hashes of the files the last install supplied; used to retire unchanged
   *  upstream removals without touching user edits. */
  managedFiles?: Record<string, string>
}

/** A file of a skill bundle, relative to the skill dir with POSIX separators. */
export interface SkillFile {
  relPath: string
  /** UTF-8 text content (text files). */
  text?: string
  /** Base64 content (binary files). */
  base64?: string
}

export interface SkillInstallResult {
  installed: InstalledSkill
  warnings: string[]
}

export interface SkillMirrorSyncResult {
  copied: string[]
  updated: string[]
  removed: string[]
  preserved: string[]
  warnings: string[]
}

/** Lowercase and hyphenated, safe for every target (OpenCode is strictest:
 *  `^[a-z0-9]+(-[a-z0-9]+)*$`). Doubles as the dir name and frontmatter name. */
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

/** Split a bundle-relative path, rejecting paths that can escape its root. */
export function skillPathSegments(relPath: string): string[] {
  const segments = relPath.split(/[\\/]/)
  const isAbsolute = /^[\\/]/.test(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)
  if (isAbsolute || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe skill file path: ${relPath}`)
  }
  return segments
}

/** Accepts "owner/name", a GitHub URL or "github.com/owner/name". */
export function parseRepo(repo: string): { owner: string; name: string } {
  const cleaned = repo
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const [owner, name] = cleaned.split('/')
  if (!owner || !name) throw new Error(`Invalid repo: ${repo}`)
  return { owner, name }
}
