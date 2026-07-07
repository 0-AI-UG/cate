// =============================================================================
// build-skills-index.mjs - crawl registry/sources.json and emit the curated
// skills-index.json that the Cate app fetches. Run by the skills-index GitHub
// Action (with GITHUB_TOKEN for a 5000/hr rate limit). Mirrors the discovery
// logic in src/skills/main/githubCrawl.ts (kept standalone so it runs as plain
// node with no build step).
// =============================================================================

import { readFile, writeFile, readdir } from 'node:fs/promises'
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

// Strip the least-indented prefix shared by all non-blank lines (YAML block
// scalar indentation).
function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min))
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fm = {}
  if (m) {
    const lines = m[1].split('\n')
    let i = 0
    while (i < lines.length) {
      const mm = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(lines[i])
      if (!mm) { i++; continue }
      const key = mm[1]
      const raw = mm[2].trim()
      // Block scalar: `key: |` (literal) or `key: >` (folded), with optional
      // chomping (+/-). Gather the following more-indented (or blank) lines.
      if (/^[|>][+-]?$/.test(raw)) {
        const fold = raw[0] === '>'
        const block = []
        i++
        while (i < lines.length && (lines[i].trim() === '' || /^[ \t]/.test(lines[i]))) {
          block.push(lines[i]); i++
        }
        while (block.length && !block[block.length - 1].trim()) block.pop()
        const body = dedent(block)
        // Folded: join lines within a paragraph by spaces, keep blank-line breaks.
        fm[key] = fold
          ? body.join('\n').split(/\n{2,}/).map((p) => p.split('\n').join(' ').trim()).join('\n').trim()
          : body.join('\n').trim()
      } else {
        fm[key] = raw.replace(/^["']|["']$/g, '')
        i++
      }
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
      // Collapse block-scalar newlines so the catalog blurb is one clean line.
      if (fm.description) description = fm.description.replace(/\s+/g, ' ').trim()
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

// First-party skills live in THIS repo. GitHub's recursive tree API truncates
// large repos (Cate is one), so a remote crawl can silently miss them - read
// them straight off disk instead, so Cate's own skills are always indexed.
async function walkSkillMds(dir) {
  const out = []
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...(await walkSkillMds(full)))
    else if (d.name === 'SKILL.md') out.push(full)
  }
  return out
}

async function localSkills(src) {
  const { owner, name } = parseRepo(src.repo)
  const base = (src.path ?? '').replace(/^\/+|\/+$/g, '')
  const root = base ? path.join(REPO_ROOT, base) : REPO_ROOT
  const out = []
  for (const full of await walkSkillMds(root)) {
    const dir = path.relative(REPO_ROOT, path.dirname(full)).split(path.sep).join('/')
    let skillName = dir.split('/').pop() || name
    let description = ''
    let tags = []
    try {
      const { fm, tags: tg } = parseFrontmatter(await readFile(full, 'utf-8'))
      if (fm.name) skillName = fm.name
      if (fm.description) description = fm.description.replace(/\s+/g, ' ').trim()
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
      source: { repo: `${owner}/${name}`, ref: src.ref || 'main', path: dir },
      provenance: 'curated',
      sourceId: src.id,
    })
  }
  return out
}

const MIN_STARS = 10_000

// Dedupe by id, apply the quality floors, and stamp first-party entries. Pure so
// it can be unit-tested against the exact filter logic the index ships with.
export function curateSkills(skills, firstPartyIds) {
  const isFirstParty = (s) => firstPartyIds.has(s.sourceId)
  // The same skill can appear at two paths in a repo (e.g. a second copy whose
  // SKILL.md has empty frontmatter), and since the id is repo+name it collides.
  // Keep one entry per id - prefer the one that actually carries a description -
  // so the catalog has no duplicate ids (which otherwise break list rendering).
  const byId = new Map()
  for (const s of skills) {
    const prev = byId.get(s.id)
    if (!prev || (!prev.description && s.description)) byId.set(s.id, s)
  }
  const deduped = [...byId.values()]
  if (deduped.length !== skills.length) {
    console.log(`Deduped ${skills.length - deduped.length} duplicate id(s)`)
  }
  // Quality floor: drop entries with no frontmatter description (no search
  // signal, render as broken rows) and from repos under MIN_STARS. Keeps the
  // catalog selective - only well-adopted, documented skills ship. First-party
  // sources (Cate's own) skip the star floor, but NOT the description floor: a
  // descriptionless skill renders as a broken row no matter who authored it.
  const described = deduped.filter((s) => s.description && s.description.trim())
  if (described.length !== deduped.length) {
    console.log(`Dropped ${deduped.length - described.length} entr(ies) with no description`)
  }
  const curated = described.filter((s) => isFirstParty(s) || (s.stars ?? 0) >= MIN_STARS)
  if (curated.length !== described.length) {
    console.log(`Dropped ${described.length - curated.length} entr(ies) under ${MIN_STARS} stars`)
  }
  // Stamp first-party entries so the UI can pin them without hardcoding a
  // source id - the `firstParty` flag on the source flows through to the entry.
  const stamped = curated.map((s) => (isFirstParty(s) ? { ...s, firstParty: true } : s))
  // Stable order so the committed index has minimal diffs.
  stamped.sort((a, b) => a.id.localeCompare(b.id))
  return stamped
}

async function main() {
  const { sources } = JSON.parse(await readFile(SOURCES_PATH, 'utf-8'))
  const skills = []
  for (const src of sources) {
    try {
      const found = src.firstParty ? await localSkills(src) : await crawlSource(src)
      console.log(`${src.repo}: ${found.length} skill(s)${src.firstParty ? ' (local)' : ''}`)
      skills.push(...found)
    } catch (err) {
      console.error(`${src.repo}: ${err.message}`)
    }
  }
  const firstPartyIds = new Set(sources.filter((s) => s.firstParty).map((s) => s.id))
  const stamped = curateSkills(skills, firstPartyIds)
  const index = { generatedAt: new Date().toISOString(), skills: stamped }
  await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`)
  console.log(`Wrote ${stamped.length} skill(s) to ${INDEX_PATH}`)
}

// Only run the crawl when invoked as a script, not when imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
