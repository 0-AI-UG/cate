// =============================================================================
// GitHub crawl helpers — discover SKILL.md skills in a repo and fetch their
// files. Used by the live user-repo crawl (skillsRegistry) and the install path
// (skillStore.materialize). The curated index is built by the CI crawler
// (scripts/build-skills-index.mjs), which mirrors this logic.
//
// Discovery: one recursive git-tree call per repo (1 API request). Frontmatter +
// file bytes are read over raw.githubusercontent.com, which is CDN-served and
// NOT part of the 60/hr REST budget. An optional token lifts the REST limit
// (60→5000/hr) and reaches private repos.
// =============================================================================

import { parseFrontmatter } from './frontmatter'
import { slugifySkillName, type SkillEntry, type SkillSource, type SkillSourceRef } from '../../shared/skills'

export interface SkillFile {
  /** Path relative to the skill dir, POSIX separators. */
  relPath: string
  /** UTF-8 text content (set for text files). */
  text?: string
  /** Base64 content (set for binary files). */
  base64?: string
}

const FETCH_TIMEOUT_MS = 12000
const MAX_FILES_PER_SKILL = 200

const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'csv', 'tsv',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'zsh', 'rb', 'go',
  'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'php', 'pl', 'lua', 'sql', 'html', 'css',
  'xml', 'svg', 'env', 'ini', 'cfg', 'gitignore', 'dockerfile',
])

function isTextPath(p: string): boolean {
  const base = p.split('/').pop() ?? ''
  if (!base.includes('.')) return true // extensionless (LICENSE, Makefile, …) → treat as text
  const ext = base.split('.').pop()!.toLowerCase()
  return TEXT_EXT.has(ext)
}

export function parseRepo(repo: string): { owner: string; name: string } {
  // Accept "owner/name", a full GitHub URL, or "github.com/owner/name".
  const cleaned = repo
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const [owner, name] = cleaned.split('/')
  if (!owner || !name) throw new Error(`Invalid repo: ${repo}`)
  return { owner, name }
}

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Cate-skills',
  }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

async function ghJson<T>(url: string, token?: string): Promise<T> {
  const res = await fetchWithTimeout(url, authHeaders(token))
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`)
  return (await res.json()) as T
}

interface RepoMeta { default_branch: string; stargazers_count: number; pushed_at: string }
interface TreeEntry { path: string; type: 'blob' | 'tree'; size?: number }
interface TreeResponse { tree: TreeEntry[]; truncated: boolean }

export async function getRepoMeta(repo: string, token?: string): Promise<RepoMeta> {
  const { owner, name } = parseRepo(repo)
  return ghJson<RepoMeta>(`https://api.github.com/repos/${owner}/${name}`, token)
}

async function getTree(repo: string, ref: string, token?: string): Promise<TreeEntry[]> {
  const { owner, name } = parseRepo(repo)
  const data = await ghJson<TreeResponse>(
    `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  )
  return data.tree ?? []
}

export async function rawText(repo: string, ref: string, path: string, token?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const segs = path.split('/').map(encodeURIComponent).join('/')
  const res = await fetchWithTimeout(
    `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${segs}`,
    token ? { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Cate-skills' } : { 'User-Agent': 'Cate-skills' },
  )
  if (!res.ok) throw new Error(`raw ${res.status} for ${path}`)
  return res.text()
}

async function rawBytes(repo: string, ref: string, path: string, token?: string): Promise<Buffer> {
  const { owner, name } = parseRepo(repo)
  const segs = path.split('/').map(encodeURIComponent).join('/')
  const res = await fetchWithTimeout(
    `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${segs}`,
    token ? { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Cate-skills' } : { 'User-Agent': 'Cate-skills' },
  )
  if (!res.ok) throw new Error(`raw ${res.status} for ${path}`)
  return Buffer.from(await res.arrayBuffer())
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

function withinBase(p: string, base: string): boolean {
  if (!base) return true
  const b = base.replace(/\/+$/, '')
  return p === `${b}/SKILL.md` || p.startsWith(`${b}/`)
}

/** Discover every SKILL.md skill in a user-added repo. One tree call + one raw
 *  read per skill (CDN). Returns catalog entries tagged with the source. */
export async function listSkillsInRepo(source: SkillSource, token?: string): Promise<SkillEntry[]> {
  const meta = await getRepoMeta(source.repo, token).catch(() => null)
  const ref = source.ref || meta?.default_branch || 'main'
  const base = (source.path ?? '').replace(/^\/+|\/+$/g, '')
  const tree = await getTree(source.repo, ref, token)
  const skillMds = tree.filter(
    (t) => t.type === 'blob' && t.path.split('/').pop() === 'SKILL.md' && withinBase(t.path, base),
  )
  const out: SkillEntry[] = []
  for (const t of skillMds) {
    const dir = dirOf(t.path)
    let name = dir.split('/').pop() || parseRepo(source.repo).name
    let description = ''
    let tags: string[] = []
    try {
      const text = await rawText(source.repo, ref, t.path, token)
      const parsed = parseFrontmatter(text)
      if (parsed.fm.name) name = parsed.fm.name
      if (parsed.fm.description) description = parsed.fm.description
      tags = parsed.tags
    } catch { /* keep dir-derived name */ }
    const slug = slugifySkillName(name)
    out.push({
      id: `${source.id}/${slug}`,
      name,
      description,
      tags,
      format: 'skill-md',
      source: { repo: source.repo, ref, path: dir },
      stars: meta?.stargazers_count,
      updatedAt: meta?.pushed_at,
      provenance: 'user',
      sourceId: source.id,
    })
  }
  return out
}

/** Fetch all files of a single skill (the SKILL.md folder) for installation. */
export async function fetchSkillFiles(src: SkillSourceRef, token?: string): Promise<SkillFile[]> {
  const ref = src.ref || (await getRepoMeta(src.repo, token).catch(() => null))?.default_branch || 'main'
  const base = (src.path ?? '').replace(/^\/+|\/+$/g, '')
  const tree = await getTree(src.repo, ref, token)
  const prefix = base ? `${base}/` : ''
  const blobs = tree
    .filter((t) => t.type === 'blob' && (base ? t.path.startsWith(prefix) : true))
    .slice(0, MAX_FILES_PER_SKILL)
  const files: SkillFile[] = []
  for (const b of blobs) {
    const relPath = base ? b.path.slice(prefix.length) : b.path
    if (!relPath) continue
    try {
      if (isTextPath(b.path)) {
        files.push({ relPath, text: await rawText(src.repo, ref, b.path, token) })
      } else {
        files.push({ relPath, base64: (await rawBytes(src.repo, ref, b.path, token)).toString('base64') })
      }
    } catch { /* skip unreadable file */ }
  }
  if (!files.some((f) => f.relPath === 'SKILL.md')) {
    throw new Error('No SKILL.md found in skill source')
  }
  return files
}
