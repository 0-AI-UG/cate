import { describe, expect, test } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertCapturedEdit, LIVE_AGENT_CHANGES } from './liveHarness'
import { createMockChangeFixture, MOCK_EDIT_PROMPT } from './liveMock'
import { createAgentChangesStore } from './store'

// Provider config (including project trust) is in the fixture's CODEX_HOME.
const codexArgs = ['exec', '--ephemeral', '--ignore-rules', '--sandbox', 'workspace-write',
  '--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"', MOCK_EDIT_PROMPT]

describe.skipIf(!LIVE_AGENT_CHANGES)('real CLI recorded changes', () => {
  test('Claude native Edit reaches shipped authenticated ingestion and durable history', { timeout: 150_000 }, async () => {
    const fixture = await createMockChangeFixture('claude-code', (cwd) => [
      { name: 'Read', arguments: { file_path: path.join(cwd, 'target.txt') } },
      { name: 'Edit', arguments: { file_path: path.join(cwd, 'target.txt'), old_string: 'before', new_string: 'after' } },
    ])
    try {
      await fixture.run('claude', ['-p', MOCK_EDIT_PROMPT, '--tools', 'Read,Edit', '--allowedTools', 'Read,Edit',
        '--permission-mode', 'acceptEdits', '--no-session-persistence', ...fixture.args.slice(0, -1)])
      await assertCapturedEdit(fixture, 'claude-code')
    } finally { await fixture.close() }
  })

  test('Codex apply_patch reaches shipped authenticated ingestion and durable history', { timeout: 150_000 }, async () => {
    const fixture = await createMockChangeFixture('codex', () => [
      { name: 'apply_patch', arguments: '*** Begin Patch\n*** Update File: target.txt\n@@\n-before\n+after\n*** End Patch' },
    ])
    try {
      const output = await fixture.run('codex', codexArgs)
      if (process.env.CATE_LIVE_KEEP_FIXTURES === '1') await writeFile(path.join(fixture.cwd, '..', 'cli-output.json'), JSON.stringify(output), { mode: 0o600 })
      await assertCapturedEdit(fixture, 'codex')
    } finally { await fixture.close() }
  })

  test('Codex real multi-file patch preserves Unicode edits, creation, deletion coverage and rename attribution', { timeout: 150_000 }, async () => {
    const patch = '*** Begin Patch\n*** Update File: nested/é.txt\n@@\n first\n-before\n+after\n last\n*** Add File: created.txt\n+created\n*** Delete File: obsolete.txt\n*** Update File: rename-before.txt\n*** Move to: rename-after.txt\n@@\n-old-name\n+new-name\n*** End Patch'
    const fixture = await createMockChangeFixture('codex', () => [{ name: 'apply_patch', arguments: patch }])
    try {
      await mkdir(path.join(fixture.cwd, 'nested'))
      await writeFile(path.join(fixture.cwd, 'nested', 'é.txt'), 'first\nbefore\nlast\n')
      await writeFile(path.join(fixture.cwd, 'obsolete.txt'), 'deleted-before-image\n')
      await writeFile(path.join(fixture.cwd, 'rename-before.txt'), 'old-name\n')
      const output = await fixture.run('codex', codexArgs)
      if (process.env.CATE_LIVE_KEEP_FIXTURES === '1') await writeFile(path.join(fixture.cwd, '..', 'cli-output.json'), JSON.stringify(output), { mode: 0o600 })
      expect(await readFile(path.join(fixture.cwd, 'nested', 'é.txt'), 'utf8')).toBe('first\nafter\nlast\n')
      expect(await readFile(path.join(fixture.cwd, 'created.txt'), 'utf8')).toBe('created\n')
      expect(await readFile(path.join(fixture.cwd, 'rename-after.txt'), 'utf8')).toBe('new-name\n')
      expect(await readFile(path.join(fixture.cwd, 'target.txt'), 'utf8')).toBe('before\n')
      await expect(stat(path.join(fixture.cwd, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(path.join(fixture.cwd, 'rename-before.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      const records = await fixture.records()
      expect(records.length).toBeGreaterThan(0)
      expect(records.every((record) => record.agentId === 'codex' && record.panelId === fixture.panelId && record.sourceId === fixture.terminalId && record.cwd === fixture.cwd)).toBe(true)
      expect(new Set(records.map((record) => record.sessionId)).size).toBe(1)
      expect(new Set(records.map((record) => record.turnId)).size).toBe(1)
      const files = records.flatMap((record) => record.files)
      expect(files.map((file) => file.path).sort()).toEqual(['created.txt', 'nested/é.txt', 'obsolete.txt', 'rename-after.txt'])
      expect(files.find((file) => file.path === 'nested/é.txt')).toMatchObject({ additions: 1, deletions: 1, coverage: 'fragment' })
      expect(files.find((file) => file.path === 'created.txt')).toMatchObject({ additions: 1, deletions: 0, coverage: 'fragment' })
      expect(files.find((file) => file.path === 'rename-after.txt')).toMatchObject({ oldPath: 'rename-before.txt', additions: 1, deletions: 1, coverage: 'fragment' })
      const changedLines = (name: string, kind: 'add' | 'delete') => files.find((file) => file.path === name)!.hunks.flatMap((hunk) => hunk.lines)
        .filter((line) => line.kind === kind).map((line) => line.text)
      expect(changedLines('nested/é.txt', 'delete')).toEqual(['before'])
      expect(changedLines('nested/é.txt', 'add')).toEqual(['after'])
      expect(changedLines('created.txt', 'add')).toEqual(['created'])
      expect(changedLines('created.txt', 'delete')).toEqual([])
      expect(changedLines('rename-after.txt', 'delete')).toEqual(['old-name'])
      expect(changedLines('rename-after.txt', 'add')).toEqual(['new-name'])
      // Native Delete File reports the path but no deleted text. Do not invent
      // a before image from the checkout or count it as a captured deletion.
      expect(files.find((file) => file.path === 'obsolete.txt')).toMatchObject({ additions: 0, deletions: 0, coverage: 'unavailable' })
      expect(files.find((file) => file.path === 'obsolete.txt')!.hunks.flatMap((hunk) => hunk.lines)).toEqual([])
      expect(await createAgentChangesStore(fixture.historyDir).list(fixture.cwd)).toEqual(records)
    } finally { await fixture.close() }
  })
})
