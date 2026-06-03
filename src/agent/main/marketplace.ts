// =============================================================================
// Pi extension marketplace — list catalog, list installed, install, uninstall.
//
// Catalog source: a live scrape of https://pi.dev/packages (server-rendered
// HTML). There is no public JSON API. When the scrape fails we surface an
// empty catalog so the UI can show "Catalog unavailable" rather than a stale
// bundled list.
//
// `listInstalled` is companion-aware: it reads <hostAgentDir>/{extensions,npm}
// through `companion.file`, so it works for local and remote workspaces alike.
//
// Install/uninstall used to shell out to a bundled pi CLI on the LOCAL machine.
// That binary no longer ships (pi is delivered on demand as a tarball run via
// `companion.agent`), and a local spawn could never reach a remote host anyway.
// Until pi exposes an install/uninstall RPC over the agent channel, these two
// operations are structured no-ops that report "not supported on this host yet"
// rather than spawning a nonexistent binary. See installExtension below.
// =============================================================================

import log from '../../main/logger'
import { hostAgentDir, hostJoin } from './agentDir'
import { parseLocator } from '../../main/companion/locator'
import { companions } from '../../main/companion/companionManager'
import type { Companion } from '../../main/companion/types'

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

function extensionsDir(companionId: string, hostCwd: string): string {
  return hostJoin(companionId, hostAgentDir(companionId, hostCwd), 'extensions')
}

function npmModulesDir(companionId: string, hostCwd: string): string {
  // Pi 0.x installs packages into <agentDir>/npm/node_modules/<name>/
  return hostJoin(companionId, hostAgentDir(companionId, hostCwd), 'npm', 'node_modules')
}

function settingsHostPath(companionId: string, hostCwd: string): string {
  return hostJoin(companionId, hostAgentDir(companionId, hostCwd), 'settings.json')
}

/** Heuristic: pi extensions that call ctx.ui.custom(...) need a real terminal
 *  to render their UI. We can't support those in Cate's agent panel today, so
 *  we flag them with a warning badge. */
const TERMINAL_REQUIRED_PATTERN = /\b(?:ctx\.ui\.custom|\.custom)\s*\(/

async function detectTerminalRequired(
  companion: Companion,
  extDir: string,
): Promise<boolean> {
  // Look at the package's main file. Try package.json -> main, else common
  // defaults (index.ts, index.js, index.mjs). All reads route through the
  // companion so this works on a remote host too.
  const candidates: string[] = []
  try {
    const pkgJsonRaw = await companion.file.readFile(hostJoin(companion.id, extDir, 'package.json'))
    const pkg = JSON.parse(pkgJsonRaw) as { main?: string }
    if (pkg.main) candidates.push(hostJoin(companion.id, extDir, pkg.main))
  } catch { /* no package.json — fine */ }
  for (const name of ['index.ts', 'index.js', 'index.mjs', 'index.cjs']) {
    candidates.push(hostJoin(companion.id, extDir, name))
  }
  for (const file of candidates) {
    try {
      const content = await companion.file.readFile(file)
      if (TERMINAL_REQUIRED_PATTERN.test(content)) return true
      // Found a readable main file — that's enough; don't peek further.
      return false
    } catch { /* try next */ }
  }
  return false
}

async function readDescription(
  companion: Companion,
  extDir: string,
): Promise<string | undefined> {
  try {
    const raw = await companion.file.readFile(hostJoin(companion.id, extDir, 'package.json'))
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

async function buildEntry(
  companion: Companion,
  name: string,
  dirPath: string,
): Promise<InstalledExtension> {
  return {
    name,
    description: await readDescription(companion, dirPath),
    requiresTerminal: await detectTerminalRequired(companion, dirPath),
    path: dirPath,
  }
}

async function scanExtensionsDir(
  companion: Companion,
  hostCwd: string,
): Promise<InstalledExtension[]> {
  const dir = extensionsDir(companion.id, hostCwd)
  // readDir yields [] for a missing dir.
  const entries = await companion.file.readDir(dir)
  const out: InstalledExtension[] = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    // Scoped packages can show up as `@scope/<name>` if pi ever organizes
    // them that way; handle both flat and one-level-of-scope layouts.
    if (entry.name.startsWith('@')) {
      const scopeDir = hostJoin(companion.id, dir, entry.name)
      try {
        const inner = await companion.file.readDir(scopeDir)
        for (const sub of inner) {
          if (!sub.isDirectory) continue
          const full = hostJoin(companion.id, scopeDir, sub.name)
          out.push(await buildEntry(companion, `${entry.name}/${sub.name}`, full))
        }
        continue
      } catch { /* fall through */ }
    }
    out.push(await buildEntry(companion, entry.name, hostJoin(companion.id, dir, entry.name)))
  }
  return out
}

async function scanInstalledPackages(
  companion: Companion,
  hostCwd: string,
): Promise<InstalledExtension[]> {
  // Pi 0.x records `pi install`-ed packages in settings.json -> packages[],
  // and unpacks them into <agentDir>/npm/node_modules/<name>/. The two
  // locations (<agentDir>/extensions and <agentDir>/npm/node_modules) are
  // disjoint — the first is for hand-placed extensions like our bundled
  // subagent, the second is for everything `pi install` puts on disk.
  let raw: string
  try { raw = await companion.file.readFile(settingsHostPath(companion.id, hostCwd)) }
  catch { return [] }
  let parsed: { packages?: string[] } = {}
  try { parsed = JSON.parse(raw) }
  catch { return [] }
  const refs = parsed.packages ?? []
  const modulesRoot = npmModulesDir(companion.id, hostCwd)
  const out: InstalledExtension[] = []
  for (const ref of refs) {
    // Refs look like "npm:<name>" or "git:<url>" or "https://..." — we only
    // resolve npm: refs to a directory we can introspect.
    if (typeof ref !== 'string') continue
    if (!ref.startsWith('npm:')) continue
    const name = ref.slice(4)
    const dirPath = hostJoin(companion.id, modulesRoot, ...name.split('/'))
    // Confirm the directory exists on the host before listing it.
    try { if (!(await companion.file.stat(dirPath)).isDirectory) continue }
    catch { continue }
    out.push(await buildEntry(companion, name, dirPath))
  }
  return out
}

export async function listInstalled(cwd: string): Promise<InstalledExtension[]> {
  const { companionId, path: hostCwd } = parseLocator(cwd)
  const companion = companions.resolve(companionId)
  const [a, b] = await Promise.all([
    scanExtensionsDir(companion, hostCwd),
    scanInstalledPackages(companion, hostCwd),
  ])
  const seen = new Set<string>()
  const out: InstalledExtension[] = []
  for (const e of [...a, ...b]) {
    if (seen.has(e.name)) continue
    seen.add(e.name)
    out.push(e)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// Install/uninstall are deferred until pi exposes an install RPC over the agent
// channel. The previous implementation spawned a bundled pi binary on the local
// machine, which (a) no longer ships and (b) could never target a remote host.
// We return a structured "not supported" so the UI shows a clear message
// instead of silently failing on a missing binary.
const INSTALL_NOT_SUPPORTED =
  'Installing pi extensions from Cate is not supported on this host yet. ' +
  'Use the pi CLI in a terminal on the workspace host (e.g. `pi install npm:<name>`).'

export async function installExtension(
  _cwd: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!name || /[\s;|&`$<>]/.test(name)) {
    return { ok: false, error: 'Invalid package name' }
  }
  log.info('[marketplace] install deferred (no pi RPC): %s', name)
  return { ok: false, error: INSTALL_NOT_SUPPORTED }
}

export async function uninstallExtension(
  _cwd: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!name || /[\s;|&`$<>]/.test(name)) {
    return { ok: false, error: 'Invalid package name' }
  }
  log.info('[marketplace] uninstall deferred (no pi RPC): %s', name)
  return { ok: false, error: INSTALL_NOT_SUPPORTED }
}
