import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { createLiveChangeFixture, runLiveCli, runLiveTui } from './agentChanges.liveHarness'

const LIVE_HERMES = process.env.CATE_LIVE_HERMES === '1'

// Opt-in paid-provider contract test. The caller owns authentication and the
// disposable Hermes profile; this test exercises Cate's production endpoint,
// managed plugin, context response, lifecycle normalization, and edit capture.
describe.skipIf(!LIVE_HERMES)('real Hermes integration', () => {
  test('managed plugin delivers context, lifecycle, and a native file edit', { timeout: 180_000 }, async () => {
    const profile = process.env.CATE_LIVE_HERMES_PROFILE
    if (!profile) throw new Error('CATE_LIVE_HERMES_PROFILE is required')
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required')

    const fixture = await createLiveChangeFixture('hermes')
    const contextValue = `cate-live-${randomUUID()}`
    fixture.hooks.setPromptContext(fixture.terminalId, `CATE_LIVE_CONTEXT=${contextValue}`)
    try {
      const prompt = 'Read target.txt, then use the native patch tool in replace mode with old_string="before" and new_string="after". Do not use write_file or a shell command. Change no other file. Integration-provided context contains CATE_LIVE_CONTEXT; after editing, reply only with its value.'
      const result = await runLiveCli('hermes', [
        '--profile', profile, 'chat', '--oneshot', '--quiet', '--provider', 'openrouter',
        '--model', process.env.CATE_LIVE_HERMES_MODEL ?? 'deepseek/deepseek-v4.1-flash-20260910',
        '--reasoning', 'none', '--toolsets', 'file', '--yolo', '--query', prompt,
      ], { cwd: fixture.cwd, env: fixture.env, timeout: 150_000 })

      expect(result.stdout).toContain(contextValue)
      expect(await readFile(`${fixture.cwd}/target.txt`, 'utf8')).toBe('after\n')
      await expect.poll(async () => (await fixture.records()).length, { timeout: 5000 }).toBe(1)
      const [record] = await fixture.records()
      expect(record).toMatchObject({
        agentId: 'hermes', source: 'terminal', sourceId: fixture.terminalId,
        panelId: fixture.panelId, cwd: fixture.cwd,
      })
      expect(record.sessionId).toBeTruthy()
      expect(record.turnId).toBeTruthy()
      expect(record.files).toHaveLength(1)
      expect(record.files[0]).toMatchObject({ path: 'target.txt', coverage: 'fragment' })
      expect(record.files[0].hunks.flatMap((hunk) => hunk.lines)
        .some((line) => line.kind === 'delete' && line.text === 'before')).toBe(true)
      expect(record.files[0].hunks.flatMap((hunk) => hunk.lines)
        .some((line) => line.kind === 'add' && line.text === 'after')).toBe(true)
      const payloads = fixture.posts.flatMap((post) => {
        const body = post.body as { payload?: Record<string, unknown> }
        return body.payload ? [body.payload] : []
      })
      const names = payloads.map((payload) => payload.hook_event_name)
      expect(names).toContain('on_session_start')
      expect(names).toContain('pre_llm_call')
      expect(names).toContain('post_tool_call')
      expect(names).toContain('on_session_end')
      expect(names).toContain('on_session_finalize')
      expect(payloads.every((payload) => payload.profile === profile)).toBe(true)
      expect(payloads.some((payload) => 'conversation_history' in payload)).toBe(false)
      expect(payloads.some((payload) => 'user_message' in payload)).toBe(false)
    } finally {
      await fixture.close()
    }
  })

  test('Cate launch form seeds a turn and remains interactive on a PTY', { timeout: 180_000 }, async () => {
    const profile = process.env.CATE_LIVE_HERMES_PROFILE
    if (!profile) throw new Error('CATE_LIVE_HERMES_PROFILE is required')
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required')

    const fixture = await createLiveChangeFixture('hermes')
    let turnEndedAt = 0
    try {
      await runLiveTui('hermes', [
        '--profile', profile, 'chat', '--cli', '--provider', 'openrouter',
        '--model', process.env.CATE_LIVE_HERMES_MODEL ?? 'deepseek/deepseek-v4.1-flash-20260910',
        '--reasoning', 'none', '--toolsets', 'file', '--query', 'Reply only OK. Do not call tools.',
      ], {
        cwd: fixture.cwd,
        env: fixture.env,
        timeout: 150_000,
        complete: () => {
          const ended = fixture.posts.some((post) => {
            const body = post.body as { payload?: { hook_event_name?: string } }
            return body.payload?.hook_event_name === 'on_session_end'
          })
          if (ended && !turnEndedAt) turnEndedAt = Date.now()
          return turnEndedAt > 0 && Date.now() - turnEndedAt >= 750
        },
      })
      const names = fixture.posts.map((post) => {
        const body = post.body as { payload?: { hook_event_name?: string } }
        return body.payload?.hook_event_name
      })
      expect(names).toContain('on_session_start')
      expect(names).toContain('pre_llm_call')
      expect(names).toContain('on_session_end')
    } finally {
      await fixture.close()
    }
  })
})
