import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { snapshotProcessTree } from '@services/terminal/runtime'
import { createAgentPresenceTracker } from '../presence'
import { describe, expect, test } from 'vitest'
import { AGENT_DEFS, type AgentSessionLocator, type AgentToolCall } from '../../contract'
import { createResumeStamps } from '../stamps'
import { PI_MANUAL_COMPACTION_CASES } from './hookLifecycle.config'
import { piSessionStore, piUsageParser } from '../sessions/pi'
import { runLiveCli, runLiveTui } from '../changes/liveHarness'
import { selectHookSmokeAgents } from './hookSmoke.config'
import { piContractFixture, startPiRpc, waitForPi } from './piContractFixture'

const enabled = process.env.CATE_LIVE_AGENT_CLIS === '1' && selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS).includes('pi')
const ended = (f: Awaited<ReturnType<typeof piContractFixture>>) => f.events.filter((event) => event.kind === 'turn-end').length
const locator = (f: Awaited<ReturnType<typeof piContractFixture>>): AgentSessionLocator => {
  const event = f.events.findLast((event) => event.kind !== 'session-title' && event.sessionId)!
  return { agentId: 'pi', sessionId: event.sessionId!, cwd: event.cwd, transcriptPath: event.transcriptPath, leafId: event.leafId }
}

describe.skipIf(!enabled)('installed Pi integration assumptions', () => {
  test.each([true, false])('automatic retry (recovers=%s) stays running across native agent_end and settles exactly once', { timeout: 40_000 }, async (recovers) => {
    let requests = 0
    const fixture = await piContractFixture({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 250, provider: { maxRetries: 0 } } },
      reply: () => ++requests === 1 || !recovers ? { type: 'error', status: 503, message: 'Service unavailable' } : { type: 'text' } })
    const pi = await startPiRpc(fixture)
    try {
      await pi.request({ type: 'prompt', message: 'CATE_RETRY' })
      await waitForPi(async () => (await fixture.audit()).some((event) => event.type === 'agent_end'), 'first native agent_end')
      expect(ended(fixture)).toBe(0)
      expect(fixture.status.status(fixture.terminalId)).toBe('running')
      expect(fixture.status.canReceivePrompt(fixture.terminalId)).toBe(false)
      await waitForPi(() => ended(fixture) === 1, 'retry settlement')
      expect(requests).toBe(2)
      expect((await fixture.audit()).filter((event) => event.type === 'agent_end')).toHaveLength(2)
      expect(fixture.status.canReceivePrompt(fixture.terminalId)).toBe(true)
    } finally { await pi.close(); await fixture.close() }
  })

  test.each(['follow-up', 'extension-continuation'] as const)('%s cannot announce final idle before automatic work finishes', { timeout: 40_000 }, async (kind) => {
    const extension = kind === 'follow-up'
      ? `let queued = false; pi.on("before_agent_start", () => { if (!queued) { queued = true; pi.sendUserMessage("CATE_QUEUED", { deliverAs: "followUp" }) } })`
      : `let continued = false; pi.on("agent_before_settle", () => { if (!continued) { continued = true; return { entries: [{ type: "custom_message", customType: "cate-continue", content: "CATE_BOUNDARY", display: false }], continue: true } } })`
    const fixture = await piContractFixture({ extension })
    const pi = await startPiRpc(fixture)
    try {
      await pi.request({ type: 'prompt', message: 'CATE_CONTINUATION' })
      await waitForPi(async () => (await fixture.audit()).some((event) => event.type === 'agent_end'), 'first low-level run')
      expect(ended(fixture)).toBe(0)
      expect(fixture.status.canReceivePrompt(fixture.terminalId)).toBe(false)
      await waitForPi(() => ended(fixture) === 1, 'all queued work settled').catch(async (error) => { throw new Error(`${error}\n${JSON.stringify({ events: fixture.events.map((e) => ({ kind: e.kind, type: e.raw.type, turnId: e.turnId })), native: await fixture.audit(), requests: fixture.provider.modelInputs.length, rpc: pi.records.filter((r) => ['agent_start', 'agent_end', 'agent_settled', 'extension_error'].includes(r.type)) })}`) })
      expect(fixture.provider.modelInputs).toHaveLength(2)
      expect((await fixture.audit()).filter((event) => event.type === 'agent_end').length).toBeGreaterThanOrEqual(1)
      if (kind === 'follow-up') expect(fixture.provider.inputText[1]).toContain('CATE_QUEUED')
    } finally { await pi.close(); await fixture.close() }
  })

  test.each(['steer', 'follow_up'] as const)('native %s input remains one busy interval until the queued prompt finishes', { timeout: 40_000 }, async (delivery) => {
    let requests = 0
    const fixture = await piContractFixture({ reply: () => ++requests === 1
      ? { type: 'tool', name: 'bash', arguments: { command: 'sleep 0.3' } } : { type: 'text' } })
    const pi = await startPiRpc(fixture)
    try {
      await pi.request({ type: 'prompt', message: 'CATE_FIRST' })
      await waitForPi(() => fixture.provider.modelInputs.length === 1, 'first provider request')
      await pi.request({ type: delivery, message: 'CATE_NATIVE_QUEUE' })
      expect(fixture.status.canReceivePrompt(fixture.terminalId)).toBe(false)
      await waitForPi(() => ended(fixture) === 1, 'queued prompt finished')
      expect(fixture.provider.inputText.slice(1).some((input) => input.includes('CATE_NATIVE_QUEUE'))).toBe(true)
      const conversation = await piSessionStore.conversation({ homeDir: fixture.directory, session: locator(fixture) })
      expect(conversation?.some((message) => message.role === 'user' && message.text === 'CATE_NATIVE_QUEUE')).toBe(true)
    } finally { await pi.close(); await fixture.close() }
  })

  test('authenticated hooks identify the real Pi process and process exit removes presence', { timeout: 30_000 }, async () => {
    const fixture = await piContractFixture()
    const pi = await startPiRpc(fixture)
    const presence = createAgentPresenceTracker({ snapshot: snapshotProcessTree })
    try {
      await waitForPi(() => fixture.posts.some((post) => post.route === '/hook'), 'native startup hook')
      const body = fixture.posts.find((post) => post.route === '/hook')!.body as { pid: number; agentId: 'pi'; terminalId: string }
      expect(body.pid).toBe(pi.pid)
      expect(body.terminalId).toBe(fixture.terminalId)
      await presence.notePost(body.terminalId, body.agentId, body.pid)
      expect(presence.presenceFor(fixture.terminalId, await snapshotProcessTree())).toEqual({ agentId: 'pi', agentPresent: true })
      await pi.close()
      await waitForPi(async () => !presence.presenceFor(fixture.terminalId, await snapshotProcessTree()).agentPresent, 'process presence falling edge')
      expect(presence.registeredAgent(fixture.terminalId)).toBeNull()
    } finally { await pi.close(); await fixture.close() }
  })

  test.each(['threshold', 'overflow'] as const)('%s compaction uses the real CLI and stays busy through recovery', { timeout: 50_000 }, async (kind) => {
    let requests = 0
    const fixture = await piContractFixture({ contextWindow: kind === 'threshold' ? 4096 : 128000,
      settings: { compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 0 } },
      reply: () => {
        requests++
        if (kind === 'overflow' && requests === 2) return { type: 'error', message: 'maximum context length exceeded' }
        return { type: 'text', promptTokens: kind === 'threshold' && requests === 1 ? 3500 : 10 }
      } })
    const pi = await startPiRpc(fixture)
    try {
      await pi.request({ type: 'prompt', message: 'CATE_HISTORY ' + 'history '.repeat(300) })
      if (kind === 'overflow') {
        await waitForPi(() => ended(fixture) === 1, 'seed turn')
        await pi.request({ type: 'prompt', message: 'CATE_OVERFLOW' })
      }
      await waitForPi(async () => (await fixture.audit()).some((event) => event.type === 'session_before_compact'), 'native automatic compaction')
      expect(ended(fixture)).toBe(kind === 'overflow' ? 1 : 0)
      expect(fixture.status.canReceivePrompt(fixture.terminalId)).toBe(false)
      await waitForPi(() => ended(fixture) === (kind === 'overflow' ? 2 : 1), 'compaction and recovery settled')
      expect((await fixture.audit()).some((event) => event.type === 'session_compact')).toBe(true)
      const session = locator(fixture)
      const transcript = await readFile(session.transcriptPath!, 'utf8')
      const entries = transcript.trim().split('\n').map((line) => JSON.parse(line))
      expect(entries.some((entry) => entry.type === 'compaction')).toBe(true)
      const parser = piUsageParser()!
      const records = transcript.trim().split('\n').flatMap((line) => parser.line(line))
      expect(records.some((record) => record.dedupeKey?.startsWith(entries.find((entry) => entry.type === 'compaction').id))).toBe(true)
      expect(requests).toBeGreaterThanOrEqual(kind === 'overflow' ? 4 : 2)
    } finally { await pi.close(); await fixture.close() }
  })

  test.each(PI_MANUAL_COMPACTION_CASES)('manual compaction keeps the terminal busy and recovers its prompt (success=$success)', { timeout: 40_000 }, async ({ success, hooks }) => {
    let requests = 0
    const fixture = await piContractFixture({ settings: { compaction: { enabled: false, keepRecentTokens: 0 } },
      reply: () => ++requests > 1 && !success ? { type: 'error' } : { type: 'text' } })
    const pi = await startPiRpc(fixture)
    try {
      await pi.request({ type: 'prompt', message: 'CATE_HISTORY ' + 'history '.repeat(300) })
      await waitForPi(() => ended(fixture) === 1, 'seed turn settled')
      const compact = pi.request({ type: 'compact' }).then(() => null, (error: unknown) => String(error))
      await waitForPi(async () => (await fixture.audit()).some((event) => event.type === 'session_before_compact'), 'manual compaction started')
      expect(fixture.status.canReceivePrompt(fixture.terminalId)).toBe(false)
      const error = await compact
      expect(error === null).toBe(success)
      await waitForPi(() => fixture.status.canReceivePrompt(fixture.terminalId), 'manual compaction finished')
      for (const type of hooks) expect(fixture.events.findLast((event) => event.raw.type === type)?.kind).toBe(type === 'session_before_compact' ? 'turn-start' : 'turn-end')
      await pi.request({ type: 'prompt', message: 'CATE_AFTER_COMPACTION' })
      await waitForPi(() => ended(fixture) === 3, 'next prompt accepted')
    } finally { await pi.close(); await fixture.close() }
  })

  test.each([true, false])('native edit arguments and execution evidence produce correct changes (success=%s)', { timeout: 30_000 }, async (success) => {
    let requests = 0
    const fixture = await piContractFixture({ reply: () => ++requests === 1
      ? { type: 'tool', name: 'edit', arguments: { path: 'target.txt', oldText: success ? 'before' : 'missing', newText: 'after' } }
      : { type: 'text' } })
    const calls: AgentToolCall[] = []
    const off = fixture.hooks.onToolCall((_terminalId, call) => calls.push(call))
    const pi = await startPiRpc(fixture)
    try {
      await pi.request({ type: 'prompt', message: 'CATE_EDIT' })
      await waitForPi(() => ended(fixture) === 1, 'edit turn settled')
      expect(await readFile(path.join(fixture.cwd, 'target.txt'), 'utf8')).toBe(success ? 'after\n' : 'before\n')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ name: 'edit', input: { path: 'target.txt', oldText: success ? 'before' : 'missing', newText: 'after' } })
      expect(calls[0].failed === true).toBe(!success)
      expect(calls[0].turnId).toBeTruthy()
      const changes = await fixture.records()
      expect(changes).toHaveLength(success ? 1 : 0)
      if (success) {
        expect(changes[0].files[0].path).toBe('target.txt')
        expect(changes[0].files[0].hunks.flatMap((hunk) => hunk.lines).map((line) => line.text)).toEqual(['before', 'after'])
      }
    } finally { off(); await pi.close(); await fixture.close() }
  })

  test('real branch navigation and cloning preserve active chat and count copied usage only once', { timeout: 40_000 }, async () => {
    const fixture = await piContractFixture({ extension: `pi.registerCommand("cate-branch", { handler: async (_args, ctx) => {
      const root = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")
      await ctx.navigateTree(root.id, { summarize: false })
    } })` })
    const pi = await startPiRpc(fixture)
    try {
      for (const [index, message] of ['CATE_ROOT', 'CATE_ABANDONED'].entries()) {
        await pi.request({ type: 'prompt', message })
        await waitForPi(() => ended(fixture) === index + 1, message)
      }
      const original = locator(fixture)
      await pi.request({ type: 'prompt', message: '/cate-branch' })
      await waitForPi(() => fixture.events.some((event) => event.raw.type === 'session_tree'), 'branch metadata')
      const branch = locator(fixture)
      expect(branch.leafId).not.toBe(original.leafId)
      const atRoot = await piSessionStore.conversation({ homeDir: fixture.directory, session: branch })
      expect(atRoot?.map((message) => message.text)).toEqual(['CATE_ROOT', fixture.provider.answer])
      await pi.request({ type: 'prompt', message: 'CATE_ACTIVE' })
      await waitForPi(() => ended(fixture) === 3, 'active branch turn')
      await pi.request({ type: 'set_session_name', name: 'CATE_NATIVE_TITLE' })
      await waitForPi(() => fixture.events.some((event) => event.raw.type === 'session_info_changed'), 'native title change')
      const active = locator(fixture)
      expect(await piSessionStore.title({ homeDir: fixture.directory, session: active })).toBe('CATE_NATIVE_TITLE')
      const messages = await piSessionStore.conversation({ homeDir: fixture.directory, session: active })
      expect(messages?.some((message) => message.text === 'CATE_ACTIVE')).toBe(true)
      expect(messages?.some((message) => message.text === 'CATE_ABANDONED')).toBe(false)
      await pi.request({ type: 'clone' })
      await waitForPi(() => locator(fixture).sessionId !== original.sessionId, 'cloned session hooks')
      const cloned = locator(fixture)
      expect(await piSessionStore.conversation({ homeDir: fixture.directory, session: cloned })).toEqual(messages)
      const all = []
      for (const file of [original.transcriptPath!, cloned.transcriptPath!]) {
        const parser = piUsageParser()!
        all.push(...(await readFile(file, 'utf8')).trim().split('\n').flatMap((line) => parser.line(line)))
      }
      expect(all.length).toBeGreaterThan(3)
      const unique = new Map(all.map((record) => [record.dedupeKey, record]))
      expect(unique.size).toBe(fixture.provider.modelInputs.length)
      expect([...unique.values()].reduce((sum, record) => sum + record.totals.uncachedInputTokens, 0)).toBe(30)
    } finally { await pi.close(); await fixture.close() }
  })

  test('extension reload preserves the persisted conversation, resume stamp and next turn hooks', { timeout: 30_000 }, async () => {
    const fixture = await piContractFixture({ extension: `pi.registerCommand("cate-reload", { handler: async (_args, ctx) => { await ctx.reload() } })` })
    let saved: string | null = null
    const stamps = createResumeStamps({ getCwd: async () => fixture.cwd, emit: (_terminalId, stamp) => { saved = stamp?.sessionId ?? null } })
    const off = fixture.hooks.subscribe((event) => stamps.ingest(event))
    const pi = await startPiRpc(fixture)
    try {
      await pi.request({ type: 'prompt', message: 'CATE_BEFORE_RELOAD' })
      await waitForPi(() => ended(fixture) === 1, 'persisted first turn')
      const original = locator(fixture)
      expect(saved).toBe(original.sessionId)
      await pi.request({ type: 'prompt', message: '/cate-reload' })
      await waitForPi(() => fixture.events.filter((event) => event.raw.type === 'session_start').length === 2, 'reloaded hooks')
      expect(saved).toBe(original.sessionId)
      expect(locator(fixture).sessionId).toBe(original.sessionId)
      await pi.request({ type: 'prompt', message: 'CATE_AFTER_RELOAD' })
      await waitForPi(() => ended(fixture) === 2, 'next turn after reload')
      const conversation = await piSessionStore.conversation({ homeDir: fixture.directory, session: locator(fixture) })
      expect(conversation?.filter((message) => message.role === 'user').map((message) => message.text)).toEqual(['CATE_BEFORE_RELOAD', 'CATE_AFTER_RELOAD'])
    } finally { off(); await pi.close(); await fixture.close() }
  })

  test.each(['outside-cate', 'hooks-off', 'untrusted'] as const)('%s does not activate the generated bridge', { timeout: 30_000 }, async (mode) => {
    const fixture = await piContractFixture({ settings: { defaultProjectTrust: mode === 'untrusted' ? 'never' : 'always' } })
    try {
      const env = { ...fixture.env }
      if (mode === 'outside-cate') { delete env.CATE_HOOK_ENDPOINT; delete env.CATE_HOOK_TOKEN; delete env.CATE_TERMINAL_ID }
      if (mode === 'hooks-off') await fixture.hooks.prepareWorkspace(fixture.cwd, { pi: 'off' })
      await mkdir(path.join(fixture.cwd, '.pi/skills/cate-contract'), { recursive: true })
      await writeFile(path.join(fixture.cwd, '.pi/skills/cate-contract/SKILL.md'), '---\nname: cate-contract\ndescription: CATE_SKILL_DISCOVERY\n---\nFixture skill.\n')
      const result = await runLiveCli(AGENT_DEFS.pi.command, ['--print', ...fixture.launch.args], { cwd: fixture.cwd, env })
      expect(result.stdout).toContain(fixture.provider.answer)
      expect(fixture.events).toEqual([])
      if (mode === 'untrusted') {
        expect(fixture.provider.inputText[0]).not.toContain('CATE_SKILL_DISCOVERY')
        await runLiveCli(AGENT_DEFS.pi.command, ['--print', '--approve', ...fixture.launch.args], { cwd: fixture.cwd, env })
        expect(fixture.events.some((event) => event.kind === 'turn-end')).toBe(true)
        expect(fixture.provider.inputText.at(-1)).toContain('CATE_SKILL_DISCOVERY')
      }
    } finally { await fixture.close() }
  })

  test('every idle extension dialog closes back to an addressable prompt', { timeout: 40_000 }, async () => {
    const fixture = await piContractFixture({ extension: `
      pi.registerCommand("cate-idle-dialogs", { handler: async (_args, ctx) => {
        await ctx.ui.select("CATE_SELECT", ["One", "Two"])
        await ctx.ui.confirm("CATE_CONFIRM", "Continue?")
        await ctx.ui.input("CATE_INPUT")
        await ctx.ui.editor("CATE_EDITOR", "Fixture")
        await ctx.ui.custom((_tui, _theme, _keys, done) => {
          const component = { render: () => ["CATE_CUSTOM"], invalidate() {}, handleInput() { done(undefined) } }
          return component
        })
        ctx.ui.notify("CATE_DIALOGS_DONE", "info")
      } })` })
    let submitted = false, submitAt = 0, seen = 0, waitingAt = 0, closed = 0
    const readyAt: boolean[] = []
    const off = fixture.hooks.subscribe((event) => {
      if (event.kind === 'permission-wait') readyAt.push(fixture.status.canReceivePrompt(fixture.terminalId))
    })
    try {
      await runLiveTui(AGENT_DEFS.pi.command, fixture.launch.args, { cwd: fixture.cwd, env: fixture.env, renderScreen: true, timeout: 25_000,
        respond: () => {
          if (!submitAt && ended(fixture) === 1) { submitAt = Date.now(); return '/cate-idle-dialogs' }
          if (submitAt && !submitted && Date.now() - submitAt > 300) { submitted = true; return '\r' }
          const count = fixture.events.filter((event) => event.kind === 'permission-wait').length
          if (count > seen) { seen = count; waitingAt = Date.now() }
          if (seen > closed && Date.now() - waitingAt > 300) { closed = seen; return '\x1b' }
          return undefined
        },
        complete: (screen) => screen.includes('CATE_DIALOGS_DONE') && fixture.events.filter((event) => event.raw.type === 'ui_prompt_end').length === 5,
      })
      expect(readyAt).toEqual([false, false, false, false, false])
      expect(fixture.events.filter((event) => event.raw.type === 'ui_prompt_end').every((event) => event.raw.idle === true)).toBe(true)
      expect(fixture.status.canReceivePrompt(fixture.terminalId)).toBe(true)
    } finally { off(); await fixture.close() }
  })
})
