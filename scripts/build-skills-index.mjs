#!/usr/bin/env node
// =============================================================================
// build-skills-index.mjs — crawl registry/sources.json and emit the curated
// skills-index.json that the Cate app fetches. Run by the skills-index GitHub
// Action (with GITHUB_TOKEN for a 5000/hr rate limit). Mirrors the discovery
// logic in src/skills/main/githubCrawl.ts (kept standalone so it runs as plain
// node with no build step).
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SOURCES_PATH = path.join(REPO_ROOT, 'registry', 'sources.json')
const INDEX_PATH = path.join(REPO_ROOT, 'registry', 'skills-index.json')

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

function authHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'Cate-skills-index' }
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`
  return h
}

function slugify(name) {
  return (
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '') || 'skill'
  )
}

function parseRepo(repo) {
  const cleaned = repo.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const [owner, name] = cleaned.split('/')
  if (!owner || !name) throw new Error(`Invalid repo: ${repo}`)
  return { owner, name }
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fm = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const mm = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line)
      if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  const tags = fm.tags ? fm.tags.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean) : []
  return { fm, tags }
}

async function ghJson(url) {
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`)
  return res.json()
}

async function rawText(owner, name, ref, p) {
  const segs = p.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${segs}`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'Cate-skills-index' } : { 'User-Agent': 'Cate-skills-index' },
  })
  if (!res.ok) throw new Error(`raw ${res.status} for ${p}`)
  return res.text()
}

function withinBase(p, base) {
  if (!base) return true
  const b = base.replace(/\/+$/, '')
  return p === `${b}/SKILL.md` || p.startsWith(`${b}/`)
}

async function crawlSource(src) {
  const { owner, name } = parseRepo(src.repo)
  const meta = await ghJson(`https://api.github.com/repos/${owner}/${name}`).catch(() => null)
  const ref = src.ref || meta?.default_branch || 'main'
  const base = (src.path ?? '').replace(/^\/+|\/+$/g, '')
  const tree = await ghJson(
    `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  )
  const skillMds = (tree.tree ?? []).filter(
    (t) => t.type === 'blob' && t.path.split('/').pop() === 'SKILL.md' && withinBase(t.path, base),
  )
  const out = []
  for (const t of skillMds) {
    const dir = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : ''
    let skillName = dir.split('/').pop() || name
    let description = ''
    let tags = []
    try {
      const { fm, tags: tg } = parseFrontmatter(await rawText(owner, name, ref, t.path))
      if (fm.name) skillName = fm.name
      if (fm.description) description = fm.description
      tags = tg
    } catch {
      /* keep dir-derived name */
    }
    out.push({
      id: `${src.id}/${slugify(skillName)}`,
      name: skillName,
      description,
      tags,
      format: 'skill-md',
      source: { repo: `${owner}/${name}`, ref, path: dir },
      stars: meta?.stargazers_count,
      updatedAt: meta?.pushed_at,
      provenance: 'curated',
      sourceId: src.id,
    })
  }
  return out
}

async function main() {
  const { sources } = JSON.parse(await readFile(SOURCES_PATH, 'utf-8'))
  const skills = []
  for (const src of sources) {
    try {
      const found = await crawlSource(src)
      console.log(`${src.repo}: ${found.length} skill(s)`)
      skills.push(...found)
    } catch (err) {
      console.error(`${src.repo}: ${err.message}`)
    }
  }
  // Stable order so the committed index has minimal diffs.
  skills.sort((a, b) => a.id.localeCompare(b.id))
  const index = { generatedAt: new Date().toISOString(), skills }
  await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`)
  console.log(`Wrote ${skills.length} skill(s) to ${INDEX_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
