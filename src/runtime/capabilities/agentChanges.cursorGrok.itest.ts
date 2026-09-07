import { describe, expect, test } from 'vitest'
import { createLiveChangeFixture, runLiveCli, assertCapturedEdit } from './agentChanges.liveHarness'

const prompt = 'Use your native file editing tool (not a shell command) to change target.txt from exactly before followed by a newline to exactly after followed by a newline. Read the file first. Do not modify any other file. Then stop.'

describe.skipIf(process.env.CATE_LIVE_AGENT_CLIS !== '1')('real CLI recorded changes', () => {
  test('Cursor native edit reaches durable attributed history', { timeout: 180_000 }, async () => {
    const fixture = await createLiveChangeFixture('cursor')
    try {
      const result = await runLiveCli('cursor-agent', ['--print', '--force', '--trust', '--model', process.env.CATE_LIVE_CURSOR_MODEL ?? 'auto', '--output-format', 'json', prompt], fixture)
      expect(result.stdout).toBeTruthy()
      await assertCapturedEdit(fixture, 'cursor')
    } finally { await fixture.close() }
  })

  test('Grok native edit reaches durable attributed history', { timeout: 180_000 }, async () => {
    const fixture = await createLiveChangeFixture('grok')
    try {
      const result = await runLiveCli('grok', ['--no-auto-update', '--no-subagents', '--disable-web-search', '--permission-mode', 'acceptEdits', '-p', prompt], {
        ...fixture, env: { ...fixture.env, GROK_FOLDER_TRUST: '0' },
      })
      expect(result.stdout).toBeTruthy()
      await assertCapturedEdit(fixture, 'grok')
    } finally { await fixture.close() }
  })
})
