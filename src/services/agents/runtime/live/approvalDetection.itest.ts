import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { readCodexApprovalConfig } from '../hooks/approvalConfig'
import { cleanHookEnv } from './hookCliFixture'
import { selectHookSmokeAgents } from './hookSmoke.config'

const enabled = process.env.CATE_LIVE_AGENT_CLIS === '1' && selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS).includes('codex')

describe.skipIf(!enabled)('installed Codex approval detection', () => {
  test.each([
    ['user', 'on-request', 'manual'],
    ['auto_review', 'on-request', 'automatic'],
    ['guardian_subagent', 'on-request', 'automatic'],
    ['user', 'never', 'automatic'],
  ] as const)('resolves reviewer=%s policy=%s as %s through the real app-server', async (reviewer, policy, mode) => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'cate-approval-')))
    const home = path.join(directory, 'codex')
    const workspace = path.join(directory, 'repo')
    try {
      await mkdir(home); await mkdir(workspace)
      const file = path.join(home, 'config.toml')
      await writeFile(file, `approvals_reviewer = "${reviewer}"\napproval_policy = "${policy}"\n`)
      const result = await readCodexApprovalConfig(workspace, { env: { ...cleanHookEnv(), CODEX_HOME: home }, timeoutMs: 15_000 })
      expect(result).toMatchObject({ source: 'config', mode })
      expect(result.detail).toContain(file)
      expect(result.detail).toContain(policy === 'never' ? 'approval_policy' : 'approvals_reviewer')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30_000)
})
