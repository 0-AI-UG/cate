// The workspace's agent usage (architecture 10.3): every agent's session store
// says where its CLI records usage (`AgentSessionStore.usage`); this reads
// them all, keeps the sessions that ran in the workspace (the root or a
// worktree under it), prices and buckets their records and totals them. Transcripts are
// cached per file in `agents/usage/`, and a file that grew re-reads only what
// was appended.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { RpcError } from '@kernel/rpc/contract'
import type { Logger } from '@kernel/log/contract'
import { writeJsonAtomic } from '@kernel/state/node'
import { AGENTS, type AgentId, type UsageAgentLimits, type UsageAgentStatus, type UsageLimitsReport, type UsageModelPriceOverride, type UsagePricing, type UsageSummary, type UsageSummaryInput } from '../../contract'
import type { AgentSessionStores, AgentUsageRecord, AgentUsageScope, AgentUsageSource } from '../sessions/types'
import { UsageAggregator } from './aggregation'
import { createOverrideRateTable, parseRateTable, type RateTable } from './pricing'
import { limitsReport } from './limits'
import { CliMissingError } from './probe'
import { summarizeUsage } from './summary'
import { dedupeWithinFile, decodeScanCache, encodeScanCache, pruneScanCache, type ScanCache } from './scanCache'
import { listTranscripts, readTranscript } from './transcripts'

export const LITELLM_RATES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const DAY_MS = 24 * 60 * 60 * 1000
/** Rates move rarely; a day-old table keeps pricing working offline. */
const RATES_TTL_MS = DAY_MS
/** An explicit refresh skips the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000
/** Files are filtered by mtime; the slack covers a session last written just
 *  before midnight on the window's first day. */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000
/** The longest window the overview offers; older cache entries are pruned. */
const CACHE_RETENTION_MS = 90 * DAY_MS
const LIMITS_TTL_MS = 60 * 1000

export interface AgentUsageDeps {
  /** The canonical workspace root; its worktrees live under it. */
  root: string
  /** Holds `model-rates.json` and `scan-cache.json`. */
  dataDir: string
  homeDir: string
  stores: AgentSessionStores
  priceOverrides(): Readonly<Record<string, UsageModelPriceOverride>>
  /** The environment the limit probes run the CLIs with. */
  env(): NodeJS.ProcessEnv
  log?: Logger
  fetchRates?: () => Promise<unknown>
  now?: () => number
}

export interface AgentUsageService {
  summary(input: UsageSummaryInput): Promise<UsageSummary>
  refreshRates(): Promise<UsagePricing>
  limits(refresh: boolean): Promise<UsageLimitsReport>
}

interface ScannedAgent {
  agent: AgentId
  status: UsageAgentStatus['status']
  note: string | null
  records: AgentUsageRecord[]
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

async function fetchLiteLlmRates(): Promise<unknown> {
  const response = await fetch(LITELLM_RATES_URL, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`rates fetch failed: ${response.status}`)
  return response.json()
}

/** Whether a session's working directory is the root or under it. CLIs
 *  record cwds as given or as realpaths, so both spellings are tried. */
function workspaceScope(root: string): (cwd: string) => Promise<boolean> {
  const inside = (dir: string) => {
    const relative = path.relative(root, dir)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }
  const known = new Map<string, Promise<boolean>>()
  return (cwd) => {
    let answer = known.get(cwd)
    if (!answer) {
      answer = inside(cwd) ? Promise.resolve(true) : fs.realpath(cwd).then(inside, () => false)
      known.set(cwd, answer)
    }
    return answer
  }
}

export function createAgentUsage(deps: AgentUsageDeps): AgentUsageService {
  const now = deps.now ?? Date.now
  const fetchRates = deps.fetchRates ?? fetchLiteLlmRates
  const ratesFile = path.join(deps.dataDir, 'model-rates.json')
  const cacheFile = path.join(deps.dataDir, 'scan-cache.json')

  // --- Rates ---

  let rates: RateTable = new Map()
  let ratesFetchedAt: number | null = null
  let ratesStatus: UsagePricing['status'] = 'unavailable'
  let ratesLoad: Promise<void> = Promise.resolve()

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt: ratesFetchedAt === null ? null : new Date(ratesFetchedAt).toISOString(),
    knownModels: rates.size,
  })

  /** A fresh table, else the snapshot on disk; with neither every model is
   *  unpriced rather than the scan failing. */
  async function loadRates(force: boolean): Promise<void> {
    const at = now()
    const maxAge = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS
    if (ratesFetchedAt !== null && at - ratesFetchedAt < maxAge) return
    if (ratesFetchedAt === null) {
      try {
        const snapshot = JSON.parse(await fs.readFile(ratesFile, 'utf8')) as { fetchedAtMs?: unknown; document?: unknown }
        const parsed = parseRateTable(snapshot.document)
        if (parsed.size > 0 && typeof snapshot.fetchedAtMs === 'number') {
          rates = parsed
          ratesFetchedAt = snapshot.fetchedAtMs
          ratesStatus = 'cached'
          if (at - snapshot.fetchedAtMs < maxAge) return
        }
      } catch {
        // No snapshot yet.
      }
    }
    let document: unknown
    try {
      document = await fetchRates()
    } catch (error) {
      deps.log?.debug('usage rates fetch failed', { error: String(error) })
      if (rates.size > 0) ratesStatus = 'cached'
      return
    }
    const parsed = parseRateTable(document)
    if (parsed.size === 0) return
    rates = parsed
    ratesFetchedAt = at
    ratesStatus = 'fresh'
    await writeJsonAtomic(ratesFile, { fetchedAtMs: at, document }, { pretty: false }).catch(() => undefined)
  }

  /** One load at a time: a burst of refreshes waits on the first. */
  const ensureRates = (force: boolean): Promise<void> => (ratesLoad = ratesLoad.then(() => loadRates(force)))

  // --- Transcripts ---

  const cache: ScanCache = new Map()
  let cacheDirty = false
  let cacheLoaded: Promise<void> | null = null

  const loadCache = (): Promise<void> => cacheLoaded ??= fs.readFile(cacheFile, 'utf8')
    .then((raw) => { for (const [file, entry] of decodeScanCache(JSON.parse(raw))) cache.set(file, entry) })
    .catch(() => undefined)

  async function saveCache(): Promise<void> {
    if (!cacheDirty) return
    try {
      await writeJsonAtomic(cacheFile, encodeScanCache(cache), { pretty: false })
      cacheDirty = false
    } catch {
      // A cache that cannot be written makes the next scan slower, not wrong.
    }
  }

  /** One transcript's records: cached while unchanged, resumed when it grew. */
  async function transcriptRecords(agent: AgentId, source: Extract<AgentUsageSource, { kind: 'transcripts' }>, file: { path: string; size: number; mtimeMs: number }): Promise<AgentUsageRecord[]> {
    const cached = cache.get(file.path)
    if (cached?.agent === agent && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return [...cached.records, ...cached.tailRecords]
    // Same size with a new mtime, or a shrunken file, is rewritten content.
    const resumeFrom = cached?.agent === agent && file.size > cached.size ? cached.position : undefined
    const read = await readTranscript(file.path, (f, state) => source.parser(f, state), resumeFrom)
    if (!read) return []
    const seen = new Set<string>()
    const records = dedupeWithinFile([...(read.resumed && cached ? cached.records : []), ...read.records], seen)
    const tailRecords = dedupeWithinFile(read.tailRecords, seen)
    cache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, agent, records, tailRecords, position: read.position })
    cacheDirty = true
    return [...records, ...tailRecords]
  }

  async function scanAgent(agent: AgentId, source: AgentUsageSource, scope: AgentUsageScope, walked: { live: Set<string>; roots: string[] }): Promise<ScannedAgent> {
    const missing: ScannedAgent = { agent, status: 'missing', note: null, records: [] }
    if (source.kind === 'transcripts') {
      const root = source.root(deps.homeDir)
      if (!await exists(root)) return missing
      walked.roots.push(root)
      const records: AgentUsageRecord[] = []
      for (const file of await listTranscripts(root, scope.sinceMs, source.fileName)) {
        walked.live.add(file.path)
        records.push(...await transcriptRecords(agent, source, file))
      }
      return { agent, status: 'ok', note: null, records }
    }
    if (!await exists(source.location(deps.homeDir))) return missing
    if (source.kind === 'none') return { agent, status: 'unsupported', note: await source.note(deps.homeDir, scope), records: [] }
    const records = await source.records(deps.homeDir, scope.sinceMs)
    return records ? { agent, status: 'ok', note: null, records } : missing
  }

  async function scan(input: UsageSummaryInput, overrides: Readonly<Record<string, UsageModelPriceOverride>>): Promise<UsageSummary> {
    if (input.sinceDay > input.untilDay) throw new RpcError('rejected', `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`)
    let hourly: { sinceTimeMs: number; untilTimeMs: number } | undefined
    if (input.resolution === 'hour') {
      const sinceTimeMs = Date.parse(input.sinceTime ?? '')
      const untilTimeMs = Date.parse(input.untilTime ?? '')
      if (!(untilTimeMs - sinceTimeMs > 0 && untilTimeMs - sinceTimeMs <= DAY_MS)) throw new RpcError('rejected', 'an hourly window is more than zero and at most 24 hours')
      hourly = { sinceTimeMs, untilTimeMs }
    }
    const firstDay = Date.parse(`${input.sinceDay}T00:00:00Z`)
    const lastDay = Date.parse(`${input.untilDay}T00:00:00Z`)
    if (Number.isNaN(firstDay) || Number.isNaN(lastDay)) throw new RpcError('rejected', 'sinceDay and untilDay are YYYY-MM-DD')

    const startedAt = now()
    await loadCache()
    const contains = workspaceScope(deps.root)
    const scope: AgentUsageScope = {
      sinceMs: (hourly?.sinceTimeMs ?? firstDay) - MTIME_SLACK_MS,
      untilMs: hourly?.untilTimeMs ?? lastDay + 2 * DAY_MS,
      contains,
    }
    const walked = { live: new Set<string>(), roots: [] as string[] }
    // The rate table loads while the stores are read instead of gating them.
    const [, scanned] = await Promise.all([
      ensureRates(false),
      Promise.all(AGENTS.map(({ id }) => scanAgent(id, deps.stores[id].usage.source, scope, walked))),
    ])

    const aggregator = new UsageAggregator({ ...input, resolution: input.resolution ?? 'day', ...hourly, rates, priceOverrides: createOverrideRateTable(overrides) })
    const stores: UsageAgentStatus[] = []
    for (const { agent, status, note, records } of scanned) {
      const sessions = new Set<string>()
      for (const record of records) {
        if (record.cwd === null || !await contains(record.cwd)) continue
        if (aggregator.add(agent, record) && record.sessionId) sessions.add(record.sessionId)
      }
      stores.push({ agent, status, sessions: sessions.size, note })
    }

    if (pruneScanCache(cache, { livePaths: walked.live, walkedRoots: walked.roots, windowStartMs: scope.sinceMs, retentionCutoffMs: startedAt - CACHE_RETENTION_MS }) > 0) cacheDirty = true
    await saveCache()

    return {
      readAt: new Date(now()).toISOString(),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      ...summarizeUsage(aggregator.finish(), stores),
      stores,
      pricing: pricing(),
      scanDurationMs: Math.max(0, now() - startedAt),
    }
  }

  /** Identical requests in flight (the overview open on two clients) share a scan. */
  const inflight = new Map<string, Promise<UsageSummary>>()

  function summary(input: UsageSummaryInput): Promise<UsageSummary> {
    const overrides = deps.priceOverrides()
    const key = JSON.stringify([input.timeZone, input.sinceDay, input.untilDay, input.resolution ?? 'day', input.sinceTime ?? null, input.untilTime ?? null, overrides])
    let running = inflight.get(key)
    if (!running) {
      running = scan(input, overrides).finally(() => inflight.delete(key))
      inflight.set(key, running)
    }
    return running
  }

  // --- Limits ---

  let limitsCache: { at: number; report: Promise<UsageLimitsReport> } | null = null

  async function readLimits(): Promise<UsageLimitsReport> {
    const probes = AGENTS.flatMap(({ id }) => {
      const probe = deps.stores[id].usage.limits
      return probe ? [{ agent: id, probe }] : []
    })
    const agents = await Promise.all(probes.map(async ({ agent, probe }): Promise<UsageAgentLimits | null> => {
      try {
        return await probe({ cwd: deps.root, env: deps.env(), now: new Date(now()) })
      } catch (error) {
        if (error instanceof CliMissingError) return null
        deps.log?.debug('usage limits probe failed', { agent, error: String(error) })
        return {
          agent,
          checkedAt: new Date(now()).toISOString(),
          windows: [],
          unavailable: { reason: 'probeFailed', message: error instanceof Error ? error.message : 'Could not read limits.' },
        }
      }
    }))
    return limitsReport(agents.filter((a): a is UsageAgentLimits => a !== null), now())
  }

  return {
    summary,
    async refreshRates() {
      await ensureRates(true)
      return pricing()
    },
    limits(refresh) {
      if (!refresh && limitsCache && now() - limitsCache.at < LIMITS_TTL_MS) return limitsCache.report
      const report = readLimits()
      limitsCache = { at: now(), report }
      return report
    },
  }
}
