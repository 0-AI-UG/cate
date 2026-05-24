// =============================================================================
// Pi extension marketplace — list catalog, list installed, install, uninstall.
//
// Catalog source: a live scrape of https://pi.dev/packages (server-rendered
// HTML). There is no public JSON API. When the scrape fails we surface an
// empty catalog so the UI can show "Catalog unavailable" rather than a stale
// bundled list.
//
// Install/uninstall shells out to the pi CLI at node_modules/.bin/pi (anchored
// on app.getAppPath() so it works both in dev and once packaged via
// electron-builder). Pi installs to ~/.pi/agent/extensions/<name>/ which is
// also where it auto-discovers them.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { app } from 'electron'
import log from '../../main/logger'

export interface MarketplaceEntry {
  name: string
  description: string
  author: string
  downloads: number
  type: string
  repoUrl: string
  requiresTerminal: boolean
}

export interface InstalledExtension {
  name: string
  description?: string
  requiresTerminal: boolean
  path: string
}

function piAgentRoot(): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

function extensionsDir(): string {
  return path.join(piAgentRoot(), 'extensions')
}

function npmModulesDir(): string {
  // Pi 0.x installs packages into ~/.pi/agent/npm/node_modules/<name>/
  return path.join(piAgentRoot(), 'npm', 'node_modules')
}

function settingsPath(): string {
  return path.join(piAgentRoot(), 'settings.json')
}

function piBinaryPath(): string {
  const base = app.getAppPath()
  const root = base.includes('app.asar') ? base.replace('app.asar', 'app.asar.unpacked') : base
  const directPath = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
  if (fs.existsSync(directPath)) return directPath
  const binName = process.platform === 'win32' ? 'pi.cmd' : 'pi'
  return path.join(root, 'node_modules', '.bin', binName)
}

/** Heuristic: pi extensions that call ctx.ui.custom(...) need a real terminal
 *  to render their UI. We can't support those in Cate's agent panel today, so
 *  we flag them with a warning badge. */
const TERMINAL_REQUIRED_PATTERN = /\b(?:ctx\.ui\.custom|\.custom)\s*\(/

async function detectTerminalRequired(extDir: string): Promise<boolean> {
  // Look at the package's main file. Try package.json -> main, else common
  // defaults (index.ts, index.js, index.mjs). Read at most ~200KB.
  const candidates: string[] = []
  try {
    const pkgJsonRaw = await fsp.readFile(path.join(extDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgJsonRaw) as { main?: string }
    if (pkg.main) candidates.push(path.join(extDir, pkg.main))
  } catch { /* no package.json — fine */ }
  for (const name of ['index.ts', 'index.js', 'index.mjs', 'index.cjs']) {
    candidates.push(path.join(extDir, name))
  }
  for (const file of candidates) {
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile()) continue
      const content = await fsp.readFile(file, 'utf-8')
      if (TERMINAL_REQUIRED_PATTERN.test(content)) return true
      // Found a readable main file — that's enough; don't peek further.
      return false
    } catch { /* try next */ }
  }
  return false
}

async function readDescription(extDir: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path.join(extDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { description?: string }
    if (typeof pkg.description === 'string' && pkg.description.trim()) {
      return pkg.description.trim()
    }
  } catch { /* */ }
  return undefined
}

// ---------------------------------------------------------------------------
// Live scraper for https://pi.dev/packages (server-rendered HTML).
//
// The page renders each entry as:
//   <article class="content-card" data-package-card="true"
//            data-package-name="..." data-package-types="extension ..."
//            data-package-downloads="<int>" data-package-date="<ms>"
//            data-package-sort-name="...">
//     ...
//     <p class="packages-desc">DESCRIPTION</p>
//     <div class="packages-meta"><span>AUTHOR</span><span>NN/mo</span><span>Nd ago</span></div>
//     <div class="packages-links">... <a href="REPO_URL">repo</a> ...</div>
//   </article>
//
// Header shows totals as "1-50 / FILTERED (of TOTAL)". Pagination links use
// ?type=extension&page=N. We pin type=extension because Cate only installs
// extensions today (themes/skills/prompts wouldn't go through `pi install`).
// Search uses the `name` query param (not `q`), confirmed by inspecting the
// form input on /packages. Sort uses ?sort=downloads|recent|name.
// ---------------------------------------------------------------------------

export type MarketplaceSort = 'downloads' | 'recent' | 'name'

export interface MarketplacePagePayload {
  entries: MarketplaceEntry[]
  totalPages: number
  page: number
}

interface FetchMarketplacePageOptions {
  page?: number
  query?: string
  sort?: MarketplaceSort
}

const PI_PACKAGES_URL = 'https://pi.dev/packages'
const FETCH_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 10 * 60 * 1000

const pageCache = new Map<string, { fetchedAt: number; payload: MarketplacePagePayload }>()

function buildPiUrl(opts: FetchMarketplacePageOptions): string {
  const params = new URLSearchParams()
  params.set('type', 'extension')
  if (opts.sort && opts.sort !== 'downloads') params.set('sort', opts.sort)
  if (opts.query && opts.query.trim()) params.set('name', opts.query.trim())
  if (opts.page && opts.page > 1) params.set('page', String(opts.page))
  const qs = params.toString()
  return qs ? `${PI_PACKAGES_URL}?${qs}` : PI_PACKAGES_URL
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).trim()
}

function attr(card: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(card)
  return m ? decodeHtmlEntities(m[1]) : undefined
}

function parseTotalPages(html: string): number {
  // Pagination shows the last page as the highest-numbered page= link.
  let max = 1
  const re = /page=(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

function parseEntries(html: string): MarketplaceEntry[] {
  const out: MarketplaceEntry[] = []
  // Each card is an <article ...> ... </article>. Use a non-greedy match
  // anchored on data-package-card="true" so we ignore other articles.
  const re = /<article\b[^>]*data-package-card="true"[\s\S]*?<\/article>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const card = m[0]
    const name = attr(card, 'data-package-name')
    if (!name) continue
    const types = attr(card, 'data-package-types') ?? 'extension'
    const downloadsRaw = attr(card, 'data-package-downloads') ?? '0'
    const downloads = parseInt(downloadsRaw, 10) || 0

    const descM = /<p class="packages-desc">([\s\S]*?)<\/p>/.exec(card)
    const description = descM ? stripTags(descM[1]) : ''

    // Author is the first <span> inside .packages-meta
    let author = ''
    const metaM = /<div class="packages-meta">([\s\S]*?)<\/div>/.exec(card)
    if (metaM) {
      const firstSpan = /<span[^>]*>([\s\S]*?)<\/span>/.exec(metaM[1])
      if (firstSpan) author = stripTags(firstSpan[1])
    }

    // Repo URL: prefer the "repo" link in .packages-links, else fall back to npm.
    let repoUrl = ''
    const linksM = /<div class="packages-links"[\s\S]*?<\/div>/.exec(card)
    const linksHtml = linksM ? linksM[0] : card
    const linkRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let lm: RegExpExecArray | null
    let npmUrl = ''
    while ((lm = linkRe.exec(linksHtml))) {
      const href = decodeHtmlEntities(lm[1])
      const label = stripTags(lm[2]).toLowerCase()
      if (label === 'repo' && !repoUrl) repoUrl = href
      else if (label === 'npm' && !npmUrl) npmUrl = href
    }
    if (!repoUrl) repoUrl = npmUrl || `https://www.npmjs.com/package/${name}`

    out.push({
      name,
      description,
      author,
      downloads,
      // The marketplace can show packages tagged with multiple types; we
      // collapse to "extension" since that's the only thing we install.
      type: types.split(/\s+/).includes('extension') ? 'extension' : types,
      repoUrl,
      requiresTerminal: false,
    })
  }
  return out
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // pi.dev returns HTML to ordinary browsers without auth.
        'accept': 'text/html,*/*;q=0.8',
        'user-agent': 'Cate/marketplace (electron)',
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function emptyPayload(page: number): MarketplacePagePayload {
  return { entries: [], totalPages: 1, page }
}

export async function fetchMarketplacePage(
  opts: FetchMarketplacePageOptions = {},
): Promise<MarketplacePagePayload> {
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const sort: MarketplaceSort = opts.sort ?? 'downloads'
  const query = (opts.query ?? '').trim()
  const url = buildPiUrl({ page, sort, query })

  const cached = pageCache.get(url)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.payload
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS)
      const entries = parseEntries(html)
      const totalPages = parseTotalPages(html)
      const payload: MarketplacePagePayload = { entries, totalPages, page }
      pageCache.set(url, { fetchedAt: Date.now(), payload })
      return payload
    } catch (err) {
      if (attempt === 0) {
        log.warn('[marketplace] fetch attempt 1 failed for %s, retrying…', url)
      } else {
        log.warn('[marketplace] fetch failed for %s: %O', url, err)
        return emptyPayload(page)
      }
    }
  }
  return emptyPayload(page)
}

async function buildEntry(name: string, dirPath: string): Promise<InstalledExtension> {
  return {
    name,
    description: await readDescription(dirPath),
    requiresTerminal: await detectTerminalRequired(dirPath),
    path: dirPath,
  }
}

async function scanExtensionsDir(): Promise<InstalledExtension[]> {
  const dir = extensionsDir()
  if (!fs.existsSync(dir)) return []
  const out: InstalledExtension[] = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Scoped packages can show up as `@scope/<name>` if pi ever organizes
    // them that way; handle both flat and one-level-of-scope layouts.
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(dir, entry.name)
      try {
        const inner = await fsp.readdir(scopeDir, { withFileTypes: true })
        for (const sub of inner) {
          if (!sub.isDirectory()) continue
          const full = path.join(scopeDir, sub.name)
          out.push(await buildEntry(`${entry.name}/${sub.name}`, full))
        }
        continue
      } catch { /* fall through */ }
    }
    out.push(await buildEntry(entry.name, path.join(dir, entry.name)))
  }
  return out
}

async function scanInstalledPackages(): Promise<InstalledExtension[]> {
  // Pi 0.x records `pi install`-ed packages in settings.json -> packages[],
  // and unpacks them into ~/.pi/agent/npm/node_modules/<name>/. The two
  // locations (~/.pi/agent/extensions and ~/.pi/agent/npm/node_modules) are
  // disjoint — the first is for hand-placed extensions like our bundled
  // subagent, the second is for everything `pi install` puts on disk.
  let raw: string
  try { raw = await fsp.readFile(settingsPath(), 'utf-8') }
  catch { return [] }
  let parsed: { packages?: string[] } = {}
  try { parsed = JSON.parse(raw) }
  catch { return [] }
  const refs = parsed.packages ?? []
  const modulesRoot = npmModulesDir()
  const out: InstalledExtension[] = []
  for (const ref of refs) {
    // Refs look like "npm:<name>" or "git:<url>" or "https://..." — we only
    // resolve npm: refs to a directory we can introspect.
    if (typeof ref !== 'string') continue
    if (!ref.startsWith('npm:')) continue
    const name = ref.slice(4)
    const dirPath = path.join(modulesRoot, ...name.split('/'))
    if (!fs.existsSync(dirPath)) continue
    out.push(await buildEntry(name, dirPath))
  }
  return out
}

export async function listInstalled(): Promise<InstalledExtension[]> {
  const [a, b] = await Promise.all([scanExtensionsDir(), scanInstalledPackages()])
  const seen = new Set<string>()
  const out: InstalledExtension[] = []
  for (const e of [...a, ...b]) {
    if (seen.has(e.name)) continue
    seen.add(e.name)
    out.push(e)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function runPi(args: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const bin = piBinaryPath()
    if (!fs.existsSync(bin)) {
      resolve({ ok: false, error: `pi binary not found at ${bin}` })
      return
    }
    const spawnBin = bin.endsWith('.js') ? process.execPath : bin
    const spawnArgs = bin.endsWith('.js') ? [bin, ...args] : args
    const child = spawn(spawnBin, spawnArgs, {
      env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE ?? '0', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      stdout += s
      log.info('[marketplace] pi %s stdout: %s', args.join(' '), s.trimEnd())
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      stderr += s
      log.info('[marketplace] pi %s stderr: %s', args.join(' '), s.trimEnd())
    })
    child.on('error', (err) => {
      log.warn('[marketplace] pi spawn error: %O', err)
      resolve({ ok: false, error: err.message })
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true })
      } else {
        const msg = (stderr.trim() || stdout.trim() || `pi exited with code ${code}`).slice(0, 4000)
        resolve({ ok: false, error: msg })
      }
    })
  })
}

export async function installExtension(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!name || /[\s;|&`$<>]/.test(name)) {
    return { ok: false, error: 'Invalid package name' }
  }
  return runPi(['install', `npm:${name}`])
}

export async function uninstallExtension(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!name || /[\s;|&`$<>]/.test(name)) {
    return { ok: false, error: 'Invalid package name' }
  }
  // `pi remove` is documented; `uninstall` is an alias.
  return runPi(['remove', `npm:${name}`])
}
