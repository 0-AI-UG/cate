import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertCapturedEdit, LIVE_AGENT_CHANGES } from './liveHarness'
import { createMockChangeFixture, MOCK_EDIT_PROMPT } from './liveMock'

describe.skipIf(!LIVE_AGENT_CHANGES)('real CLI recorded changes', () => {
  test('Cursor native edit reaches durable attributed history', { timeout: 180_000 }, async () => {
    // Cursor's fake transport carries one whole-file write.
    const fixture = await createMockChangeFixture('cursor', (cwd) => [{ name: 'Write', arguments: { path: path.join(cwd, 'target.txt'), text: 'after\n' } }])
    try {
      const result = await fixture.run('cursor-agent', ['--print', '--force', '--output-format', 'json', ...fixture.args])
      expect(result.stdout).toBeTruthy()
      await assertCapturedEdit(fixture, 'cursor')
    } finally { await fixture.close() }
  })

  test('Grok native edit reaches durable attributed history', { timeout: 180_000 }, async () => {
    const fixture = await createMockChangeFixture('grok', (cwd) => [
      { name: 'read_file', arguments: { target_file: path.join(cwd, 'target.txt') } },
      { name: 'search_replace', arguments: { file_path: path.join(cwd, 'target.txt'), old_string: 'before', new_string: 'after' } },
    ])
    try {
      const result = await fixture.run('grok', ['--no-auto-update', '--permission-mode', 'acceptEdits', ...fixture.args.slice(0, -1), '-p', MOCK_EDIT_PROMPT])
      expect(result.stdout).toBeTruthy()
      await assertCapturedEdit(fixture, 'grok')
    } finally { await fixture.close() }
  })
})
