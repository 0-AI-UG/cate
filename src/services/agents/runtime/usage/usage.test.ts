import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_STORES } from '../sessions'
import type { AgentUsageLineParser } from '../sessions/types'
import { UsageAggregator } from './aggregation'
import { limitsReport } from './limits'
import { lookupRate, parseRateTable, priceUsage } from './pricing'
import { decodeScanCache, encodeScanCache, type ScanCache } from './scanCache'
import { readTranscript } from './transcripts'
import { createAgentUsage } from './usage'

const RATES = {
  'claude-sonnet-4-5': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 0.3e-6, cache_creation_input_token_cost: 3.75e-6 },
  'openai/gpt-5': { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6 },
  'gpt-4.1': { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
}

const claudeLine = (id: string, at: string, cwd: string, usage: Record<string, number>) => JSON.stringify({
  type: 'assistant', timestamp: at, sessionId: `s-${id}`, requestId: `r-${id}`, cwd,
  message: { id, model: 'claude-sonnet-4-5', usage },
})

/** Counts lines; its state is the count, so a resume can be checked. */
const countingParser = (_file: string, state?: unknown): AgentUsageLineParser | null => {
  if (state !== undefined && typeof state !== 'number') return null
  let lines = (state as number | undefined) ?? 0
  return {
    line: (text) => {
      lines++
      return [{ timestampMs: lines, model: text, sessionId: '', cwd: null, totals: { uncachedInputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 }, reportedCostUsd: null, dedupeKey: null }]
    },
    state: () => lines,
  }
}

describe('pricing', () => {
  const table = parseRateTable(RATES)

  it('aliases bare names and never prices synthetic or family names', () => {
    expect(lookupRate(table, 'gpt-5')).not.toBeNull()
    expect(lookupRate(table, 'claude-sonnet-4-5[1m]')).not.toBeNull()
    expect(lookupRate(table, '<synthetic>')).toBeNull()
    expect(lookupRate(table, 'sonnet')).toBeNull()
  })

  it('prefers a custom price, then a recorded cost, then the rate table', () => {
    const totals = { uncachedInputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    expect(priceUsage(table, 'gpt-5', totals, null)).toEqual({ costUsd: 1.25, costSource: 'modelPriced' })
    expect(priceUsage(table, 'gpt-5', totals, 9)).toEqual({ costUsd: 9, costSource: 'providerReported' })
    expect(priceUsage(table, 'gpt-5', totals, 9, new Map([['gpt-5', { inputCostPerToken: 2e-6, outputCostPerToken: 0, cacheReadCostPerToken: 0, cacheCreationCostPerToken: 0 }]])).costUsd).toBe(2)
    expect(priceUsage(table, 'mystery', totals, null).costSource).toBe('unpriced')
  })
})

describe('aggregation', () => {
  it('buckets by day in the zone and counts a repeated response once', () => {
    const aggregator = new UsageAggregator({ timeZone: 'America/New_York', sinceDay: '2026-10-01', untilDay: '2026-10-01', rates: parseRateTable(RATES) })
    const record = { timestampMs: Date.parse('2026-10-02T02:00:00Z'), model: 'claude-sonnet-4-5', sessionId: 's', cwd: '/w', totals: { uncachedInputTokens: 1000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 }, reportedCostUsd: null, dedupeKey: 'k' }
    expect(aggregator.add('claude-code', record)).toBe(true)
    expect(aggregator.add('claude-code', { ...record })).toBe(false)
    // 05:00 UTC on Oct 2 is Oct 2 in New York: outside the window.
    expect(aggregator.add('claude-code', { ...record, dedupeKey: null, timestampMs: Date.parse('2026-10-02T05:00:00Z') })).toBe(false)
    const [bucket] = aggregator.finish()
    expect(bucket).toMatchObject({ day: '2026-10-01', agent: 'claude-code', records: 1, costSource: 'modelPriced' })
    expect(bucket.costUsd).toBeCloseTo(0.003)
  })
})

describe('transcripts and the scan cache', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'cate-usage-transcripts-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('resumes a grown file with the parser state and keeps an unfinished line apart', async () => {
    const file = path.join(dir, 't.jsonl')
    writeFileSync(file, 'a\nb')
    const first = (await readTranscript(file, countingParser))!
    expect(first.records.map((r) => r.model)).toEqual(['a'])
    expect(first.tailRecords.map((r) => r.model)).toEqual(['b'])
    appendFileSync(file, '\nc\n')
    const second = (await readTranscript(file, countingParser, first.position))!
    expect(second.resumed).toBe(true)
    expect(second.records.map((r) => [r.model, r.timestampMs])).toEqual([['b', 2], ['c', 3]])

    // A rewritten file fails the guard and is read from the start.
    writeFileSync(file, `${'x'.repeat(100)}\ny\n`)
    expect((await readTranscript(file, countingParser, second.position))!.resumed).toBe(false)
  })

  it('round-trips and drops corrupt entries', async () => {
    const file = path.join(dir, 't.jsonl')
    writeFileSync(file, 'a\n')
    const read = (await readTranscript(file, countingParser))!
    const cache: ScanCache = new Map([[file, { size: 1, mtimeMs: 2, agent: 'codex', records: read.records, tailRecords: [], position: read.position }]])
    const encoded = JSON.parse(JSON.stringify(encodeScanCache(cache)))
    expect(decodeScanCache(encoded).get(file)).toEqual(cache.get(file))
    encoded.files[file].gl = 9999
    expect(decodeScanCache(encoded).size).toBe(0)
  })
})

describe('workspace usage', () => {
  let home: string
  let data: string
  let root: string
  let elsewhere: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cate-usage-home-')))
    data = mkdtempSync(path.join(os.tmpdir(), 'cate-usage-data-'))
    root = path.join(home, 'proj')
    elsewhere = path.join(home, 'other')
    mkdirSync(path.join(root, '.cate', 'worktrees', 'wt'), { recursive: true })
    mkdirSync(elsewhere)
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  })

  async function seedSqlite(file: string, sql: string[]): Promise<void> {
    mkdirSync(path.dirname(file), { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    for (const statement of sql) db.exec(statement)
    db.close()
  }

  function seedStores(at: number): Promise<void[]> {
    const iso = new Date(at).toISOString()
    const claude = path.join(home, '.claude', 'projects', '-proj')
    mkdirSync(claude, { recursive: true })
    const usage = { input_tokens: 1000, output_tokens: 100 }
    writeFileSync(path.join(claude, 'a.jsonl'), `${claudeLine('m1', iso, root, usage)}\n${claudeLine('m2', iso, path.join(root, '.cate', 'worktrees', 'wt'), usage)}\n${claudeLine('m3', iso, elsewhere, usage)}\n`)
    // A resumed session copies m1 into another file.
    writeFileSync(path.join(claude, 'b.jsonl'), `${claudeLine('m1', iso, root, usage)}\n`)
    const codex = path.join(home, '.codex', 'sessions', '2026', '10', '10')
    mkdirSync(codex, { recursive: true })
    writeFileSync(path.join(codex, 'rollout.jsonl'), [
      { timestamp: iso, type: 'session_meta', payload: { id: 'cx', cwd: root } },
      { timestamp: iso, type: 'turn_context', payload: { model: 'gpt-5', cwd: root } },
      { timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, output_tokens: 50 } } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n')
    const grok = path.join(home, '.grok', 'sessions', encodeURIComponent(root), 'g1')
    mkdirSync(grok, { recursive: true })
    writeFileSync(path.join(grok, 'updates.jsonl'), `${JSON.stringify({ timestamp: at / 1000, params: { sessionId: 'g1', update: { sessionUpdate: 'turn_completed', prompt_id: 'p', usage: { inputTokens: 40, outputTokens: 4, costUsdTicks: 1e8 } } } })}\n`)
    const kiro = path.join(home, '.kiro', 'sessions', 'key', 'sess_1')
    mkdirSync(kiro, { recursive: true })
    writeFileSync(path.join(kiro, 'session.json'), JSON.stringify({ workspacePaths: [root] }))
    writeFileSync(path.join(kiro, 'messages.jsonl'), `${JSON.stringify({ timestamp: iso, payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', usage: 0.5 }] } })}\n`)
    mkdirSync(path.join(home, '.cursor'))
    const opencode = JSON.stringify({ role: 'assistant', modelID: 'gpt-4.1', cost: 0, path: { cwd: root }, tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } }, time: { created: at, completed: at } })
    return Promise.all([
      seedSqlite(path.join(home, '.local', 'share', 'opencode', 'opencode.db'), [
        'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
        `INSERT INTO message VALUES ('m', 'oc', ${at}, ${at}, '${opencode}')`,
        `INSERT INTO message VALUES ('n', 'oc2', ${at}, ${at}, '${opencode.replace(root, elsewhere)}')`,
      ]),
      seedSqlite(path.join(home, '.hermes', 'state.db'), [
        'CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)',
        `INSERT INTO sessions VALUES ('h', '${root}')`,
        'CREATE TABLE session_model_usage (session_id TEXT, model TEXT, task TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, first_seen REAL, last_seen REAL)',
        `INSERT INTO session_model_usage VALUES ('h', 'gpt-4.1', '', 200, 20, 0, 0, 0, 0, 0, ${at / 1000}, ${at / 1000})`,
      ]),
    ])
  }

  const service = (options: { fetchRates?: () => Promise<unknown> } = {}) => createAgentUsage({
    root, dataDir: data, homeDir: home, stores: AGENT_SESSION_STORES, env: () => ({}),
    priceOverrides: () => ({ 'gpt-5': { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 10 } }),
    fetchRates: options.fetchRates ?? (async () => RATES), now: () => Date.parse('2026-10-11T00:00:00Z'),
  })

  it('counts every agent CLI\'s sessions that ran in the workspace or its worktrees', async () => {
    await seedStores(Date.parse('2026-10-10T12:00:00Z'))
    const input = { sinceDay: '2026-10-01', untilDay: '2026-10-10', timeZone: 'UTC' }
    const summary = await service().summary(input)

    expect(Object.fromEntries(summary.stores.map((a) => [a.agent, [a.status, a.sessions]]))).toEqual({
      'claude-code': ['ok', 2], codex: ['ok', 1], grok: ['ok', 1], opencode: ['ok', 1], hermes: ['ok', 1], kiro: ['unsupported', 0], cursor: ['unsupported', 0],
    })
    expect(summary.stores.find((a) => a.agent === 'kiro')?.note).toBe('Kiro records credits, not tokens: 0.50 credits across 1 session.')

    const byAgent = Object.fromEntries(summary.agents.map((a) => [a.agent, a]))
    // m1 (root, repeated in b.jsonl) and m2 (worktree); m3 ran elsewhere.
    expect(byAgent['claude-code'].records).toBe(2)
    expect(byAgent['claude-code'].totalTokens).toBe(2200)
    expect(byAgent['claude-code'].sessions).toBe(2)
    expect(byAgent.codex.costUsd).toBeCloseTo(500e-6 + 50 * 10e-6)
    expect(byAgent.grok.costUsd).toBeCloseTo(0.01)
    // Reasoning tokens are part of the output and not counted twice.
    expect(byAgent.opencode.totalTokens).toBe(165)
    // A zero cost from a subscription provider is priced by the rate table.
    expect(byAgent.opencode.costUsd).toBeGreaterThan(0)
    expect(byAgent.hermes.totalTokens).toBe(220)
    expect(summary.sessions).toBe(6)
    expect(summary.costUsd).toBeCloseTo(summary.agents.reduce((sum, a) => sum + a.costUsd, 0))
    expect(summary.daily.map((d) => d.day)).toEqual(['2026-10-10'])
    expect(summary.daily[0].byAgent.codex?.costUsd).toBeCloseTo(byAgent.codex.costUsd)
    expect(summary.notes).toEqual(['Cursor keeps no token counts on this machine.', 'Kiro records credits, not tokens: 0.50 credits across 1 session.'])

    // A later scan reads the cache, and an offline one keeps the saved rates.
    const warm = await service({ fetchRates: async () => { throw new Error('offline') } }).summary(input)
    expect(warm.pricing.status).toBe('cached')
    expect(warm.agents).toEqual(summary.agents)
    expect(warm.models).toEqual(summary.models)
  })
})

describe('usage limits report', () => {
  it('reports what is left and the pace, and only the probes that failed', () => {
    const now = Date.parse('2026-10-11T00:00:00Z')
    const report = limitsReport([
      {
        agent: 'claude-code', checkedAt: '2026-10-11T00:00:00Z', email: 'a@b.c', windows: [
          { id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 10, resetsAt: '2026-10-14T12:00:00Z', windowDurationMins: 7 * 24 * 60 },
          { id: 'session', kind: 'session', label: 'Session', usedPercent: 80, resetsAt: '2026-10-11T04:00:00Z', windowDurationMins: 5 * 60 },
        ],
      },
      { agent: 'codex', checkedAt: '2026-10-11T00:00:00Z', windows: [], unavailable: { reason: 'probeFailed', message: 'timed out' } },
      { agent: 'grok', checkedAt: '2026-10-11T00:00:00Z', windows: [], unavailable: { reason: 'unsupported' } },
    ], now)
    expect(report.accounts).toHaveLength(1)
    // Session first; 80% used a fifth into the window is ahead, 10% half-way is under.
    expect(report.accounts[0].windows.map((w) => [w.id, w.remainingPercent, w.pace])).toEqual([['session', 20, 'ahead'], ['weekly', 90, 'under']])
    expect(report.accounts[0]).not.toHaveProperty('unavailable')
    expect(report.notices).toEqual([{ agent: 'codex', message: 'timed out' }])
  })
})
