import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { createAgentChangesStore } from './agentChanges'
import { assertCapturedEdit, createLiveChangeFixture, runLiveCli, runLiveTui, LIVE_AGENT_CHANGES } from './agentChanges.liveHarness'

// Opt-in paid provider calls. Missing executables/authentication are failures
// when selected, never evidence of a successful live capture integration.
describe.skipIf(!LIVE_AGENT_CHANGES)('real CLI recorded changes', () => {
  test('OpenCode real provider edit reaches shipped capture and recorded diff', { timeout: 180_000 }, async () => {
    const fixture = await createLiveChangeFixture('opencode')
    try {
      const prompt = 'Read target.txt, then use the edit tool with filePath="target.txt", oldString="before", newString="after". Keep the existing newline. Do not use write, apply_patch, or shell tools. Do not change any other file. Then stop.'
      await runLiveCli('opencode', ['run', '--auto', '--format', 'json', '--model', process.env.CATE_LIVE_OPENCODE_MODEL ?? 'openai/gpt-5.4-mini', prompt], {
        cwd: fixture.cwd,
        env: { ...fixture.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
        timeout: 150_000,
      })
      await assertCapturedEdit(fixture, 'opencode')
    } finally { await fixture.close() }
  })

  test('OpenCode multiline edit in a nested Unicode path matches the filesystem after durable reload', { timeout: 180_000 }, async () => {
    const fixture = await createLiveChangeFixture('opencode')
    const filePath = 'src/café-你好.txt'
    const before = 'alpha\nbefore\nomega\n'
    const after = 'alpha\nafter\nsecond\nomega\n'
    try {
      await mkdir(path.join(fixture.cwd, 'src'))
      await writeFile(path.join(fixture.cwd, filePath), before)
      await fixture.run('git', ['add', filePath])
      const prompt = `Read ${filePath}. Use the native edit tool to replace only the text "before" with "after" followed by a newline and "second". Keep alpha, omega, and all existing newlines unchanged. Do not use a shell to edit. Do not change any other file. Then stop.`
      await runLiveCli('opencode', ['run', '--auto', '--format', 'json', '--model', process.env.CATE_LIVE_OPENCODE_MODEL ?? 'openai/gpt-5.4-mini', prompt], {
        cwd: fixture.cwd, env: { ...fixture.env, OPENCODE_DISABLE_AUTOUPDATE: '1' }, timeout: 150_000,
      })
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

  test('Kiro real provider edit reaches shipped capture and recorded diff', { timeout: 180_000 }, async () => {
    const fixture = await createLiveChangeFixture('kiro')
    try {
      // Kiro 2.21.1 headless performs edits but emits no workspace hooks.
      // Exercise the same v3 TUI Cate launches, approving only this one edit.
      const prompt = 'Read target.txt, then use the native str_replace tool to replace before with after, preserving the newline. Do not use write_file, fs_write, or shell tools. Change no other file. Then stop.'
      let approved = false
      await runLiveTui('kiro-cli', ['chat', '--v3', prompt], {
        cwd: fixture.cwd, env: fixture.env, timeout: 150_000,
        complete: () => fixture.posts.some((post) => (post.body as { payload?: { hook_event_name?: string } }).payload?.hook_event_name === 'Stop'),
        respond: (screen) => {
          if (!approved && /Replace in File requires approval\s+fs_write → target\.txt\s+❯ Allow/.test(screen)) {
            approved = true
            return '\r'
          }
        },
      })
      await assertCapturedEdit(fixture, 'kiro')
    } finally { await fixture.close() }
  })
})
