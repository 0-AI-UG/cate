// Discover SKILL.md skills in a GitHub repo and fetch their files: one
// recursive git-tree call per repo, file bytes over raw.githubusercontent.com
// (CDN, outside the REST rate budget). A token lifts the REST limit and
// reaches private repos. The curated index is built by the CI crawler
// (scripts/build-skills-index.mjs), which mirrors this logic.

import { parseFrontmatter, parseRepo, slugifySkillName, type SkillEntry, type SkillFile, type SkillSource, type SkillSourceRef } from '../contract'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

interface GithubAccess {
  fetch: FetchLike
  token?: string
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
  if (!base.includes('.')) return true // extensionless (LICENSE, Makefile) is text
  return TEXT_EXT.has(base.split('.').pop()!.toLowerCase())
}

export async function fetchWithTimeout(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { signal: ctrl.signal, headers, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

async function ghJson<T>(url: string, gh: GithubAccess): Promise<T> {
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Cate-skills' }
  if (gh.token) headers['Authorization'] = `Bearer ${gh.token}`
  const res = await fetchWithTimeout(gh.fetch, url, headers)
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`)
  return (await res.json()) as T
}

interface RepoMeta { default_branch: string; stargazers_count: number; pushed_at: string }
interface TreeEntry { path: string; type: 'blob' | 'tree'; size?: number }
interface TreeResponse { tree: TreeEntry[]; truncated: boolean }

async function getRepoMeta(repo: string, gh: GithubAccess): Promise<RepoMeta> {
  const { owner, name } = parseRepo(repo)
  return ghJson<RepoMeta>(`https://api.github.com/repos/${owner}/${name}`, gh)
}

async function getTree(repo: string, ref: string, gh: GithubAccess): Promise<TreeEntry[]> {
  const { owner, name } = parseRepo(repo)
  const data = await ghJson<TreeResponse>(
    `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    gh,
  )
  return data.tree ?? []
}

async function rawFetch(repo: string, ref: string, filePath: string, gh: GithubAccess): Promise<Response> {
  const { owner, name } = parseRepo(repo)
  const segs = filePath.split('/').map(encodeURIComponent).join('/')
  const headers: Record<string, string> = { 'User-Agent': 'Cate-skills' }
  if (gh.token) headers['Authorization'] = `Bearer ${gh.token}`
  const res = await fetchWithTimeout(gh.fetch, `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${segs}`, headers)
  if (!res.ok) throw new Error(`raw ${res.status} for ${filePath}`)
  return res
}

export async function rawText(repo: string, ref: string, filePath: string, gh: GithubAccess): Promise<string> {
  return (await rawFetch(repo, ref, filePath, gh)).text()
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

/** Every SKILL.md skill in a workspace source repo, as catalog entries. */
export async function listSkillsInRepo(source: SkillSource, gh: GithubAccess): Promise<SkillEntry[]> {
  const meta = await getRepoMeta(source.repo, gh).catch(() => null)
  const ref = source.ref || meta?.default_branch || 'main'
  const base = (source.path ?? '').replace(/^\/+|\/+$/g, '')
  const tree = await getTree(source.repo, ref, gh)
  const skillMds = tree.filter((t) => t.type === 'blob' && t.path.split('/').pop() === 'SKILL.md' && withinBase(t.path, base))
  const out: SkillEntry[] = []
  for (const t of skillMds) {
    const dir = dirOf(t.path)
    let name = dir.split('/').pop() || parseRepo(source.repo).name
    let description = ''
    let tags: string[] = []
    try {
      const parsed = parseFrontmatter(await rawText(source.repo, ref, t.path, gh))
      if (parsed.fm.name) name = parsed.fm.name
      if (parsed.fm.description) description = parsed.fm.description.replace(/\s+/g, ' ').trim()
      tags = parsed.tags
    } catch { /* keep the dir-derived name */ }
    out.push({
      id: `${source.id}/${slugifySkillName(name)}`,
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

/** All files of one skill (its SKILL.md folder), for installing. */
export async function fetchSkillFiles(src: SkillSourceRef, gh: GithubAccess): Promise<SkillFile[]> {
  const ref = src.ref || (await getRepoMeta(src.repo, gh).catch(() => null))?.default_branch || 'main'
  const base = (src.path ?? '').replace(/^\/+|\/+$/g, '')
  const tree = await getTree(src.repo, ref, gh)
  const prefix = base ? `${base}/` : ''
  const blobs = tree.filter((t) => t.type === 'blob' && (base ? t.path.startsWith(prefix) : true)).slice(0, MAX_FILES_PER_SKILL)
  const files: SkillFile[] = []
  for (const b of blobs) {
    const relPath = base ? b.path.slice(prefix.length) : b.path
    if (!relPath) continue
    try {
      if (isTextPath(b.path)) {
        files.push({ relPath, text: await rawText(src.repo, ref, b.path, gh) })
      } else {
        const bytes = Buffer.from(await (await rawFetch(src.repo, ref, b.path, gh)).arrayBuffer())
        files.push({ relPath, base64: bytes.toString('base64') })
      }
    } catch { /* skip an unreadable file */ }
  }
  if (!files.some((f) => f.relPath === 'SKILL.md')) throw new Error('No SKILL.md found in skill source')
  return files
}
