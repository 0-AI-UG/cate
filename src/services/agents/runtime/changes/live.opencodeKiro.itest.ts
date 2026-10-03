import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { createAgentChangesStore } from './store'
import { assertCapturedEdit, runLiveTui, LIVE_AGENT_CHANGES } from './liveHarness'
import { createMockChangeFixture, MOCK_EDIT_PROMPT } from './liveMock'

const opencodeArgs = ['run', '--auto', '--format', 'json', '--model', 'cate/cate-mock', MOCK_EDIT_PROMPT]

// Missing executables are failures when selected, never evidence of a
// successful capture integration.
describe.skipIf(!LIVE_AGENT_CHANGES)('real CLI recorded changes', () => {
  test('OpenCode native edit reaches shipped capture and recorded diff', { timeout: 180_000 }, async () => {
    const fixture = await createMockChangeFixture('opencode', (cwd) => [
      { name: 'read', arguments: { filePath: path.join(cwd, 'target.txt') } },
      { name: 'edit', arguments: { filePath: path.join(cwd, 'target.txt'), oldString: 'before', newString: 'after' } },
    ])
    try {
      await fixture.run('opencode', opencodeArgs)
      await assertCapturedEdit(fixture, 'opencode')
    } finally { await fixture.close() }
  })

  test('OpenCode multiline edit in a nested Unicode path matches the filesystem after durable reload', { timeout: 180_000 }, async () => {
    const filePath = 'src/café-你好.txt'
    const before = 'alpha\nbefore\nomega\n'
    const after = 'alpha\nafter\nsecond\nomega\n'
    const fixture = await createMockChangeFixture('opencode', (cwd) => [
      { name: 'read', arguments: { filePath: path.join(cwd, filePath) } },
      { name: 'edit', arguments: { filePath: path.join(cwd, filePath), oldString: 'before', newString: 'after\nsecond' } },
    ])
    try {
      await mkdir(path.join(fixture.cwd, 'src'))
      await writeFile(path.join(fixture.cwd, filePath), before)
      await fixture.run('git', ['add', filePath])
      await fixture.run('opencode', opencodeArgs)
      expect(await readFile(path.join(fixture.cwd, filePath), 'utf8')).toBe(after)
      expect(await readFile(path.join(fixture.cwd, 'target.txt'), 'utf8')).toBe('before\n')
      await expect.poll(async () => (await fixture.records()).some((record) => record.files.some((file) => file.path === filePath)), { timeout: 5000 }).toBe(true)
      const records = await createAgentChangesStore(fixture.historyDir).list(fixture.cwd)
      const matching = records.filter((record) => record.files.some((file) => file.path === filePath))
      expect(matching).toHaveLength(1)
      expect(matching[0]).toMatchObject({ agentId: 'opencode', source: 'terminal', sourceId: fixture.terminalId, panelId: fixture.panelId })
      const file = matching[0].files.find((entry) => entry.path === filePath)!
      expect(file.coverage).not.toBe('unavailable')
      let reconstructed = before
      for (const hunk of file.hunks) {
        const oldText = hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text).join('\n')
        const newText = hunk.lines.filter((line) => line.kind !== 'delete').map((line) => line.text).join('\n')
        expect(oldText).not.toBe('')
        expect(reconstructed).toContain(oldText)
        reconstructed = reconstructed.replace(oldText, newText)
      }
      expect(reconstructed, 'persisted provider-reported diff reconstructs the exact multiline edit').toBe(after)
      const diff = await fixture.run('git', ['diff', '--numstat', '--', filePath])
      expect(diff.stdout).toMatch(/^2\t1\t/)
    } finally { await fixture.close() }
  })

  test('Kiro native edit reaches shipped capture and recorded diff', { timeout: 180_000 }, async () => {
    const fixture = await createMockChangeFixture('kiro', (cwd) => [
      { name: 'str_replace', arguments: { path: path.join(cwd, 'target.txt'), oldStr: 'before', newStr: 'after' } },
    ])
    try {
      // Kiro headless performs edits but emits no workspace hooks. Exercise
      // the same v3 TUI Cate launches, approving only this one edit.
      let approved = false
      await runLiveTui('kiro-cli', fixture.args, {
        cwd: fixture.cwd, env: fixture.env, timeout: 150_000,
        complete: () => fixture.posts.some((post) => (post.body as { payload?: { hook_event_name?: string } }).payload?.hook_event_name === 'Stop'),
        respond: (screen) => {
          if (!approved && /requires approval[\s\S]*target\.txt[\s\S]*Allow/.test(screen)) {
            approved = true
            return '\r'
          }
        },
      })
      await assertCapturedEdit(fixture, 'kiro')
    } finally { await fixture.close() }
  })
})
