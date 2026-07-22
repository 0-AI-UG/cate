// @vitest-environment jsdom
//
// The iterate/verify loop's verdict plumbing: parsing the verifier's per-check
// results (junk-dropping + truncation), checks + suggestion travelling into the
// orchestrator's wake context via buildRunContext, and the select_winner verdict
// gate — only an iteration that passed verification can land.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Iteration } from '../../shared/types'

const h = vi.hoisted(() => {
  const iterations = [
    {
      id: 'it-passed-111',
      todoId: 't1',
      round: 1,
      worktreeId: 'wt-pass',
      branch: 'cate/pass',
      agents: [],
      status: 'passed',
      verify: { met: true, reason: 'tests pass', at: 1 },
      createdAt: 0,
    },
    {
      id: 'it-failed-222',
      todoId: 't1',
      round: 1,
      worktreeId: 'wt-fail',
      branch: 'cate/fail',
      agents: [],
      status: 'failed',
      verify: {
        met: false,
        reason: '2 tests fail',
        at: 1,
        checks: [{ check: 'vitest suite', met: false, observed: 'AssertionError: boom (store > undo)', expected: '0 failed' }],
        suggestion: 'fix the undo stack ordering first',
      },
      createdAt: 0,
    },
    {
      id: 'it-running-333',
      todoId: 't1',
      round: 1,
      worktreeId: 'wt-run',
      branch: 'cate/run',
      agents: [],
      status: 'running',
      createdAt: 0,
    },
  ]
  return {
    run: { status: 'running', goal: 'the goal', check: 'run tests', round: 1, iterations },
    patchRun: vi.fn(),
    appendMessage: vi.fn(),
    closeCanvasPanel: vi.fn(),
    teardownWorktree: vi.fn(),
    worktreeMetaFor: vi.fn((_wsId: string, id: string) => ({ path: `/worktrees/${id}`, color: 'rgb(0,0,0)' })),
  }
})

vi.mock('../../renderer/stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: [{ id: 'ws1', panels: {} }] }) },
  pickWorktreeColor: () => 'rgb(0,0,0)',
}))
vi.mock('../../renderer/lib/workspace/canvasAccess', () => ({ getAgentCanvasStore: () => undefined }))
vi.mock('./canvasAgentLauncher', () => ({ runCanvasAgentToCompletion: vi.fn() }))
vi.mock('./cateAgentTerminals', () => ({
  shortId: (id: string) => id.slice(0, 8),
  closeCanvasPanel: h.closeCanvasPanel,
  readTerminalState: vi.fn(),
  ptyFor: () => undefined,
  terminalBusy: () => false,
}))
vi.mock('../../renderer/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('../../renderer/stores/chatsStore', () => ({
  useChatsStore: {
    getState: () => ({
      getChats: () => [],
      getChat: () => ({ id: 't1', title: 'x', messages: [], createdAt: 0, updatedAt: 0 }),
      getRun: () => h.run,
      patchRun: h.patchRun,
      appendMessage: h.appendMessage,
      patchMessage: vi.fn(),
    }),
  },
}))
vi.mock('../../renderer/stores/gitStatusStore', () => ({ gitStatusStore: { refresh: vi.fn() } }))
vi.mock('./cateAgentStore', () => ({ useCateAgentStore: { getState: () => ({ get: () => ({}), setUnseen: vi.fn(), appendFeed: vi.fn() }) } }))
vi.mock('../../renderer/stores/canvas/helpers', () => ({ generateId: () => 'id' }))
vi.mock('./codingAgentLauncher', () => ({ runDriverToCompletion: vi.fn(), openDriverTerminal: vi.fn(), armBackgroundSend: vi.fn() }))
vi.mock('./cateAgentWorktrees', () => ({ worktreeMetaFor: h.worktreeMetaFor, teardownWorktree: h.teardownWorktree }))
vi.mock('../../renderer/lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn() } }))

import { runCateAgentTool, parseVerdictChecks, buildRunContext, runIterationCheck } from './cateAgentTools'
import type { CateAgentContext } from './cateAgentTypes'

const ctx: CateAgentContext = { panelId: 'cate-agent-orchestrator:t', workspaceId: 'ws1', rootPath: '/repo', role: 'orchestrator', chatId: 't1', canvasPanelId: 'canvas-1' }

beforeEach(() => vi.clearAllMocks())

describe('parseVerdictChecks', () => {
  it('keeps well-formed checks, trimming strings and defaulting met to false', () => {
    const out = parseVerdictChecks([
      { check: ' vitest suite ', met: true, observed: ' 214 passed ' },
      { check: 'resize keeps aspect', met: 'yes', observed: 'ratio drifts', expected: 'ratio stable' },
    ])
    expect(out).toEqual([
      { check: 'vitest suite', met: true, observed: '214 passed' },
      { check: 'resize keeps aspect', met: false, observed: 'ratio drifts', expected: 'ratio stable' },
    ])
  })

  it('drops entries missing a check name or observed outcome, and junk entries', () => {
    const out = parseVerdictChecks([
      { check: 'no observed', met: true },
      { check: '  ', met: true, observed: 'blank name' },
      'a string',
      null,
      ['nested'],
      { check: 'kept', met: true, observed: 'ok', extra: 'ignored' },
    ])
    expect(out).toEqual([{ check: 'kept', met: true, observed: 'ok' }])
  })

  it('bounds size: check count and string lengths', () => {
    const out = parseVerdictChecks(
      Array.from({ length: 30 }, (_, i) => ({ check: `c${i}`, met: true, observed: 'o'.repeat(2000) })),
    )!
    expect(out).toHaveLength(20)
    expect(out[0].observed).toHaveLength(700)
  })

  it('returns undefined when nothing survives', () => {
    expect(parseVerdictChecks(undefined)).toBeUndefined()
    expect(parseVerdictChecks(null)).toBeUndefined()
    expect(parseVerdictChecks('not a list')).toBeUndefined()
    expect(parseVerdictChecks([])).toBeUndefined()
    expect(parseVerdictChecks([{ met: false }, null])).toBeUndefined()
  })
})

describe('buildRunContext', () => {
  it('folds each verdict, including its checks and suggestion, into the wake context', () => {
    const out = JSON.parse(buildRunContext('ws1', '/repo', 't1'))
    expect(out.goal).toBe('the goal')
    const failed = out.iterations.find((i: { status: string }) => i.status === 'failed')
    expect(failed.verdict).toEqual({
      met: false,
      reason: '2 tests fail',
      checks: [{ check: 'vitest suite', met: false, observed: 'AssertionError: boom (store > undo)', expected: '0 failed' }],
      suggestion: 'fix the undo stack ordering first',
    })
    const passed = out.iterations.find((i: { status: string }) => i.status === 'passed')
    expect(passed.verdict).toEqual({ met: true, reason: 'tests pass' })
  })
})

describe('runIterationCheck verdict read-back', () => {
  const iteration = h.run.iterations[2] as Iteration // running, worktree wt-run

  const stubVerdictFile = (content: string | Error): void => {
    Object.assign(window, {
      electronAPI: {
        fsReadFile: vi.fn(() => (content instanceof Error ? Promise.reject(content) : Promise.resolve(content))),
      },
    })
  }

  it('forces met:false when any check failed, even if the top-level flag claims true', async () => {
    stubVerdictFile(
      JSON.stringify({
        met: true,
        reason: 'all good',
        checks: [
          { check: 'build', met: true, observed: 'exit 0' },
          { check: 'tests', met: false, observed: '1 failed', expected: '0 failed' },
        ],
        suggestion: 'fix the failing test',
      }),
    )
    const verdict = await runIterationCheck('ws1', '/repo', 't1', iteration)
    expect(verdict.met).toBe(false)
    expect(verdict.checks).toHaveLength(2)
    expect(verdict.suggestion).toBe('fix the failing test')
  })

  it('treats a missing verdict file as not met', async () => {
    stubVerdictFile(new Error('ENOENT'))
    const verdict = await runIterationCheck('ws1', '/repo', 't1', iteration)
    expect(verdict).toEqual({ met: false, reason: 'the checker did not produce a clear verdict' })
  })
})

describe('select_winner verdict gate', () => {
  it('rejects an iteration that failed verification, echoing its verdict', async () => {
    const out = JSON.parse(await runCateAgentTool(ctx, 'select_winner', { iterationId: 'it-failed-222' }))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('has not passed verification')
    expect(out.error).toContain('not met: 2 tests fail')
    expect(h.patchRun).not.toHaveBeenCalled()
  })

  it('rejects an iteration with no verdict yet', async () => {
    const out = JSON.parse(await runCateAgentTool(ctx, 'select_winner', { iterationId: 'it-running-333' }))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('no verdict yet')
    expect(h.patchRun).not.toHaveBeenCalled()
  })

  it('lands a passed iteration and discards the rest', async () => {
    const out = JSON.parse(await runCateAgentTool(ctx, 'select_winner', { iterationId: 'it-passed-111', reason: 'clean diff' }))
    expect(out).toEqual({ ok: true })
    expect(h.patchRun).toHaveBeenCalledWith('/repo', 't1', expect.objectContaining({ status: 'review', worktreeId: 'wt-pass', branch: 'cate/pass' }))
    const discarded = h.teardownWorktree.mock.calls.map((c) => c[2])
    expect(discarded).toEqual(expect.arrayContaining(['wt-fail', 'wt-run']))
    expect(discarded).not.toContain('wt-pass')
  })
})

// Type-level guard: the fixtures above must stay valid Iterations.
const _typecheck: Iteration[] = h.run.iterations as Iteration[]
void _typecheck
