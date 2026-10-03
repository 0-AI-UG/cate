import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { LIVE_AGENT_CHANGES, runLiveTui } from './liveHarness'
import { createMockChangeFixture, MOCK_EDIT_PROMPT } from './liveMock'

// Cate's production endpoint, managed plugin, context response, lifecycle
// normalization, and edit capture, in a disposable Hermes profile.
describe.skipIf(!LIVE_AGENT_CHANGES)('real Hermes integration', () => {
  test('managed plugin delivers context, lifecycle, and a native file edit', { timeout: 180_000 }, async () => {
    const fixture = await createMockChangeFixture('hermes', (cwd) => [
      { name: 'patch', arguments: { mode: 'replace', path: path.join(cwd, 'target.txt'), old_string: 'before', new_string: 'after' } },
    ])
    const profile = fixture.args[1]
    const contextValue = `cate-live-${randomUUID()}`
    fixture.hooks.setPromptContext(fixture.terminalId, `CATE_LIVE_CONTEXT=${contextValue}`)
    try {
      const result = await fixture.run('hermes', [
        '--profile', profile, 'chat', '--oneshot', '--quiet', '--provider', 'custom', '--model', 'cate-mock',
        '--reasoning', 'none', '--toolsets', 'file', '--yolo', '--query', MOCK_EDIT_PROMPT,
      ])

      expect(fixture.provider.inputText.some((text) => text.includes(contextValue)), 'integration context reached the model').toBe(true)
      expect(result.stdout).toContain(fixture.provider.answer)
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
    const fixture = await createMockChangeFixture('hermes', () => [], 'Reply only OK. Do not call tools.')
    let turnEndedAt = 0
    try {
      await runLiveTui('hermes', [...fixture.args.slice(0, -2), '--reasoning', 'none', '--toolsets', 'file', ...fixture.args.slice(-2)], {
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
