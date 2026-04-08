// =============================================================================
// Usage IPC handlers — JSONL session log parsing for Claude / Codex / OpenCode
// =============================================================================

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import { watch, FSWatcher } from 'chokidar'
import { ipcMain, BrowserWindow } from 'electron'
import log from '../logger'
import { USAGE_GET_SUMMARY, USAGE_GET_PROJECT, USAGE_UPDATE } from '../../shared/ipc-channels'
import { priceUsage } from '../../shared/modelPricing'
import type { AgentTool, TokenCounts, ModelUsage, DayUsage, ProjectTotals, ProjectUsage, UsageSummary } from '../../shared/types'

// =============================================================================
// Internal types
// =============================================================================

interface ParsedEntry {
  messageId: string
  model: string
  tokens: TokenCounts
  timestamp: string // ISO
}

interface FileCacheEntry {
  mtime: number
  size: number
  byteOffset: number
  entriesByMessageId: Map<string, ParsedEntry>
  projectPath: string
  tool: AgentTool
}

// =============================================================================
// In-memory cache
// =============================================================================

const fileCache = new Map<string, FileCacheEntry>()

// =============================================================================
// Directory roots
// =============================================================================

function getSourceRoots(): { dir: string; tool: AgentTool }[] {
  const home = os.homedir()
  const roots: { dir: string; tool: AgentTool }[] = [
    { dir: path.join(home, '.claude', 'projects'), tool: 'claude' },
    { dir: path.join(home, '.codex', 'sessions'), tool: 'codex' },
  ]
  // OpenCode — detect at runtime, tolerate absence
  const opencodePaths = [
    path.join(home, '.local', 'share', 'opencode'),
    path.join(home, '.opencode'),
  ]
  for (const p of opencodePaths) {
    if (fsSync.existsSync(p)) {
      roots.push({ dir: p, tool: 'opencode' })
      break
    }
  }
  return roots
}

// =============================================================================
// Project path resolution
// =============================================================================

/**
 * Decode a Claude-encoded directory name (under ~/.claude/projects/) back to
 * an absolute path.  Claude encodes the cwd by replacing every `/` with `-`,
 * prepending with `-` so the leading slash maps to the very first `-`.
 *
 * e.g.  `-Users-paul-projects-myapp`  →  `/Users/paul/projects/myapp`
 */
function decodeClaudioProjectDir(dirName: string): string {
  // The directory name starts with `-` representing the leading `/` of the path.
  // Replace ALL `-` with `/`.
  return dirName.replace(/-/g, '/')
}

/**
 * Given the absolute path of a JSONL file under ~/.claude/projects/, return
 * the decoded project (cwd) path.  Ignores `subagents/` subdirectory segments.
 */
function claudeProjectPath(filePath: string, claudeProjectsRoot: string): string {
  const rel = path.relative(claudeProjectsRoot, filePath)
  // rel looks like: <encoded-dir>/session.jsonl
  //            or:  <encoded-dir>/subagents/<uuid>/session.jsonl
  const parts = rel.split(path.sep)
  if (parts.length === 0) return 'unattributed'
  const encodedDir = parts[0]
  return decodeClaudioProjectDir(encodedDir)
}

// =============================================================================
// Per-file meta (session cwd) cache for Codex / OpenCode
// =============================================================================

const fileCwdCache = new Map<string, string | null>()

/**
 * Read the first line of a JSONL file looking for `type:"session_meta"` with
 * `payload.cwd`.  Returns null if not found.
 */
async function readSessionCwd(filePath: string): Promise<string | null> {
  if (fileCwdCache.has(filePath)) return fileCwdCache.get(filePath) ?? null
  let cwd: string | null = null
  try {
    const fd = await fs.open(filePath, 'r')
    try {
      // Read up to 4KB which is more than enough for the first line
      const buf = Buffer.allocUnsafe(4096)
      const { bytesRead } = await fd.read(buf, 0, 4096, 0)
      const chunk = buf.toString('utf-8', 0, bytesRead)
      const firstLine = chunk.split('\n')[0]
      if (firstLine) {
        const obj = JSON.parse(firstLine)
        if (obj?.type === 'session_meta' && typeof obj?.payload?.cwd === 'string') {
          cwd = obj.payload.cwd
        }
      }
    } finally {
      await fd.close()
    }
  } catch {
    // Tolerate any error — file may be empty or malformed
  }
  fileCwdCache.set(filePath, cwd)
  return cwd
}

// =============================================================================
// JSONL parsing helpers
// =============================================================================

function coerceTokens(usage: Record<string, unknown>): TokenCounts {
  // Claude shape: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
  // OpenAI/Codex shape: prompt_tokens, completion_tokens (no cache fields)
  return {
    input:       (usage.input_tokens       ?? usage.prompt_tokens      ?? 0) as number,
    output:      (usage.output_tokens      ?? usage.completion_tokens   ?? 0) as number,
    cacheCreate: (usage.cache_creation_input_tokens ?? 0) as number,
    cacheRead:   (usage.cache_read_input_tokens     ?? 0) as number,
  }
}

function extractEntry(line: string): ParsedEntry | null {
  try {
    const obj = JSON.parse(line)
    if (!obj || typeof obj !== 'object') return null

    // We need a message.id, message.model, message.usage  (Claude shape)
    // or a top-level id + model + usage  (some Codex shapes)
    const msg = obj.message ?? obj
    const msgId: string | undefined = msg.id ?? obj.id
    const model: string | undefined = msg.model ?? obj.model
    const usage: Record<string, unknown> | undefined = msg.usage ?? obj.usage

    if (!msgId || !model || !usage) return null
    if (typeof msgId !== 'string' || typeof model !== 'string') return null
    if (typeof usage !== 'object' || Array.isArray(usage)) return null

    const timestamp: string =
      obj.timestamp ?? obj.created_at ?? msg.created_at ?? new Date(0).toISOString()

    return {
      messageId: msgId,
      model,
      tokens: coerceTokens(usage),
      timestamp: typeof timestamp === 'number'
        ? new Date(timestamp * 1000).toISOString()
        : String(timestamp),
    }
  } catch {
    return null
  }
}

// =============================================================================
// Incremental file parsing
// =============================================================================

async function parseFileIncremental(filePath: string, tool: AgentTool, projectPath: string): Promise<void> {
  let stat: { mtimeMs: number; size: number }
  try {
    const s = await fs.stat(filePath)
    stat = { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    // File disappeared — remove from cache
    fileCache.delete(filePath)
    fileCwdCache.delete(filePath)
    return
  }

  const existing = fileCache.get(filePath)

  if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
    // Nothing changed
    return
  }

  const startOffset = existing?.byteOffset ?? 0
  const entriesByMessageId: Map<string, ParsedEntry> = existing?.entriesByMessageId ?? new Map()

  let newBytes = ''
  try {
    const fd = await fs.open(filePath, 'r')
    try {
      const totalBytes = stat.size - startOffset
      if (totalBytes > 0) {
        const buf = Buffer.allocUnsafe(totalBytes)
        const { bytesRead } = await fd.read(buf, 0, totalBytes, startOffset)
        newBytes = buf.toString('utf-8', 0, bytesRead)
      }
    } finally {
      await fd.close()
    }
  } catch {
    return
  }

  if (newBytes) {
    const lines = newBytes.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const entry = extractEntry(trimmed)
      if (entry) {
        entriesByMessageId.set(entry.messageId, entry)
      }
    }
  }

  fileCache.set(filePath, {
    mtime: stat.mtimeMs,
    size: stat.size,
    byteOffset: stat.size,
    entriesByMessageId,
    projectPath,
    tool,
  })
}

// =============================================================================
// Directory scan
// =============================================================================

async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const sub = await walkJsonlFiles(fullPath)
        results.push(...sub)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath)
      }
    }))
  } catch {
    // Directory does not exist or is not accessible — tolerate silently
  }
  return results
}

async function scanRoot(dir: string, tool: AgentTool, claudeProjectsRoot?: string): Promise<void> {
  const files = await walkJsonlFiles(dir)
  await Promise.all(files.map(async (filePath) => {
    let projectPath: string
    if (tool === 'claude' && claudeProjectsRoot) {
      projectPath = claudeProjectPath(filePath, claudeProjectsRoot)
    } else {
      // Codex / OpenCode: read first line for session_meta.cwd
      const cwd = await readSessionCwd(filePath)
      projectPath = cwd ?? 'unattributed'
    }
    await parseFileIncremental(filePath, tool, projectPath)
  }))
}

async function scanAll(): Promise<void> {
  const roots = getSourceRoots()
  const home = os.homedir()
  const claudeProjectsRoot = path.join(home, '.claude', 'projects')
  await Promise.all(
    roots.map(({ dir, tool }) =>
      scanRoot(dir, tool, tool === 'claude' ? claudeProjectsRoot : undefined)
    )
  )
}

// =============================================================================
// Aggregation
// =============================================================================

function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
  }
}

function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
}

function addNullableCost(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

function buildSummary(): UsageSummary {
  // Aggregate: projectPath -> model -> { tokens, cost, count, lastActivity }
  type ModelKey = string // `${projectPath}\0${model}\0${tool}`
  const modelAgg = new Map<ModelKey, {
    projectPath: string; model: string; tool: AgentTool
    tokens: TokenCounts; costUsd: number | null; messageCount: number
    lastActivity: string
  }>()

  // projectPath -> date -> { tokens, cost }
  type DayKey = string // `${projectPath}\0${date}`
  const dayAgg = new Map<DayKey, { projectPath: string; date: string; tokens: TokenCounts; costUsd: number | null }>()

  for (const cacheEntry of fileCache.values()) {
    const { projectPath, tool } = cacheEntry
    for (const entry of cacheEntry.entriesByMessageId.values()) {
      const { model, tokens, timestamp } = entry
      const cost = priceUsage(model, tokens)
      const date = timestamp.slice(0, 10) // YYYY-MM-DD

      // Model aggregation
      const mKey: ModelKey = `${projectPath}\0${model}\0${tool}`
      const mAgg = modelAgg.get(mKey)
      if (mAgg) {
        mAgg.tokens = addTokenCounts(mAgg.tokens, tokens)
        mAgg.costUsd = addNullableCost(mAgg.costUsd, cost)
        mAgg.messageCount += 1
        if (timestamp > mAgg.lastActivity) mAgg.lastActivity = timestamp
      } else {
        modelAgg.set(mKey, {
          projectPath, model, tool,
          tokens: { ...tokens },
          costUsd: cost,
          messageCount: 1,
          lastActivity: timestamp,
        })
      }

      // Day aggregation
      const dKey: DayKey = `${projectPath}\0${date}`
      const dAgg = dayAgg.get(dKey)
      if (dAgg) {
        dAgg.tokens = addTokenCounts(dAgg.tokens, tokens)
        dAgg.costUsd = addNullableCost(dAgg.costUsd, cost)
      } else {
        dayAgg.set(dKey, {
          projectPath, date,
          tokens: { ...tokens },
          costUsd: cost,
        })
      }
    }
  }

  // Build per-project data
  const projectMap = new Map<string, {
    byModel: ModelUsage[]; byDay: DayUsage[]; totals: ProjectTotals; lastActivity: string
  }>()

  const ensureProject = (projectPath: string) => {
    if (!projectMap.has(projectPath)) {
      projectMap.set(projectPath, {
        byModel: [], byDay: [],
        totals: { tokens: zeroTokens(), costUsd: null, messageCount: 0 },
        lastActivity: '',
      })
    }
    return projectMap.get(projectPath)!
  }

  for (const m of modelAgg.values()) {
    const proj = ensureProject(m.projectPath)
    proj.byModel.push({
      model: m.model, tool: m.tool,
      tokens: m.tokens, costUsd: m.costUsd, messageCount: m.messageCount,
    })
    proj.totals.tokens = addTokenCounts(proj.totals.tokens, m.tokens)
    proj.totals.costUsd = addNullableCost(proj.totals.costUsd, m.costUsd)
    proj.totals.messageCount += m.messageCount
    if (m.lastActivity > proj.lastActivity) proj.lastActivity = m.lastActivity
  }

  for (const d of dayAgg.values()) {
    const proj = ensureProject(d.projectPath)
    proj.byDay.push({ date: d.date, tokens: d.tokens, costUsd: d.costUsd })
  }

  // Sort days within each project
  for (const proj of projectMap.values()) {
    proj.byDay.sort((a, b) => a.date.localeCompare(b.date))
  }

  // Separate unattributed from real projects
  const unattributedData = projectMap.get('unattributed')
  projectMap.delete('unattributed')

  const emptyProjectUsage = (projectPath: string): ProjectUsage => ({
    projectPath,
    byModel: [], byDay: [],
    totals: { tokens: zeroTokens(), costUsd: null, messageCount: 0 },
    lastActivity: '',
  })

  const unattributed: ProjectUsage = unattributedData
    ? { projectPath: 'unattributed', ...unattributedData }
    : emptyProjectUsage('unattributed')

  const projects: ProjectUsage[] = [...projectMap.entries()]
    .map(([projectPath, data]) => ({ projectPath, ...data }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))

  // Global totals
  const globalTotals: ProjectTotals = {
    tokens: zeroTokens(),
    costUsd: null,
    messageCount: 0,
  }
  for (const p of [...projects, unattributed]) {
    globalTotals.tokens = addTokenCounts(globalTotals.tokens, p.totals.tokens)
    globalTotals.costUsd = addNullableCost(globalTotals.costUsd, p.totals.costUsd)
    globalTotals.messageCount += p.totals.messageCount
  }

  return { totals: globalTotals, projects, unattributed }
}

// =============================================================================
// Chokidar watcher + debounce
// =============================================================================

const watchers: FSWatcher[] = []

function broadcastUpdate(changedProjects: string[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_UPDATE, { changedProjects })
    }
  }
}

function startWatching(): void {
  const roots = getSourceRoots()
  const home = os.homedir()
  const claudeProjectsRoot = path.join(home, '.claude', 'projects')

  for (const { dir, tool } of roots) {
    if (!fsSync.existsSync(dir)) continue

    // Limit watcher scope to avoid EMFILE on machines with many session files.
    // Layout for all supported tools is <root>/<project>/<session>.jsonl, so
    // depth 2 covers everything we care about. Ignore non-jsonl paths so we
    // don't open fs handles for unrelated files.
    const watcher = watch(dir, {
      ignoreInitial: true,
      persistent: false,
      depth: 2,
      ignored: (p: string, stats?: { isFile: () => boolean }) => {
        if (stats?.isFile() && !p.endsWith('.jsonl')) return true
        return false
      },
    })

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const pendingProjects = new Set<string>()

    const scheduleUpdate = (filePath: string): void => {
      // Optimistically derive the project path
      let proj: string
      if (tool === 'claude') {
        proj = claudeProjectPath(filePath, claudeProjectsRoot)
      } else {
        // For Codex/OpenCode we can't cheaply decode here; mark as unknown
        proj = fileCwdCache.get(filePath) ?? 'unattributed'
      }
      pendingProjects.add(proj)

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(async () => {
        debounceTimer = null
        const changed = [...pendingProjects]
        pendingProjects.clear()

        // Re-parse only the changed file
        let projectPath: string
        if (tool === 'claude') {
          projectPath = claudeProjectPath(filePath, claudeProjectsRoot)
        } else {
          const cwd = await readSessionCwd(filePath)
          projectPath = cwd ?? 'unattributed'
        }
        await parseFileIncremental(filePath, tool, projectPath)

        broadcastUpdate(changed)
      }, 500)
    }

    watcher.on('add', scheduleUpdate)
    watcher.on('change', scheduleUpdate)
    watcher.on('unlink', (filePath: string) => {
      fileCache.delete(filePath)
      fileCwdCache.delete(filePath)
      broadcastUpdate([])
    })

    watchers.push(watcher)
  }
}

// =============================================================================
// Public: register IPC handlers + kick off initial scan
// =============================================================================

export function registerUsageHandlers(): void {
  // Kick off background scan — don't await, fire-and-forget on startup
  scanAll().then(() => {
    log.info('[usage] Initial scan complete, %d files cached', fileCache.size)
  }).catch((err: unknown) => {
    log.error('[usage] Initial scan error', err)
  })

  startWatching()

  ipcMain.handle(USAGE_GET_SUMMARY, async () => {
    try {
      return buildSummary()
    } catch (error) {
      log.error(`[${USAGE_GET_SUMMARY}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(USAGE_GET_PROJECT, async (_event, projectPath: string) => {
    try {
      const summary = buildSummary()
      if (projectPath === 'unattributed') return summary.unattributed
      const found = summary.projects.find((p) => p.projectPath === projectPath)
      return found ?? null
    } catch (error) {
      log.error(`[${USAGE_GET_PROJECT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })
}
