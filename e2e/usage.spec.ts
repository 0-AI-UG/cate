// The usage overview reads the agent CLIs' own stores on the runtime's
// machine and counts the sessions that ran in the workspace: seeded Claude
// Code and Codex transcripts show up as tokens (a session in another folder
// does not), and a stand-in `claude` answers the Limits view's request.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { closeApp, launchApp, makeHome, makeProject, type LaunchResult } from './fixtures/electron-app'

let app: LaunchResult | undefined
test.afterEach(async () => { await closeApp(app?.electronApp); app = undefined })

function seedTranscripts(home: string, project: string): void {
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const claude = path.join(home, '.claude', 'projects', '-proj')
  mkdirSync(claude, { recursive: true })
  const turn = (id: string, cwd: string, timestamp = at) => JSON.stringify({
    type: 'assistant', timestamp, sessionId: id, requestId: `r-${id}`, cwd,
    message: { id, model: 'claude-e2e-model', usage: { input_tokens: 1_200_000, output_tokens: 300_000, cache_read_input_tokens: 500_000 } },
  })
  // Fill the 90-day breakdown with enough rows to scroll at the default window size.
  const olderTurns = Array.from({ length: 20 }, (_, index) => {
    const timestamp = new Date(Date.now() - (40 + index) * 86_400_000).toISOString()
    return turn(`old-${index}`, project, timestamp)
  })
  writeFileSync(path.join(claude, 's1.jsonl'), [turn('m1', project), turn('m2', path.join(home, 'elsewhere')), ...olderTurns].join('\n') + '\n')
  const codex = path.join(home, '.codex', 'sessions', 'today')
  mkdirSync(codex, { recursive: true })
  writeFileSync(path.join(codex, 'rollout.jsonl'), [
    { timestamp: at, type: 'session_meta', payload: { id: 'cx', cwd: project } },
    { timestamp: at, type: 'turn_context', payload: { model: 'codex-e2e-model' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1_000_000, output_tokens: 0 } } } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
}

/** A `claude` that answers stream-json control requests like Claude Code. */
function fakeClaude(home: string): string {
  const bin = path.join(home, 'usage-bin')
  mkdirSync(bin, { recursive: true })
  const script = path.join(bin, 'claude')
  writeFileSync(script, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const { request_id, request } = JSON.parse(line)
  const response = request.subtype === 'initialize'
    ? { account: { email: 'e2e@cate.test' } }
    : { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 25, resets_at: new Date(Date.now() + 3600e3).toISOString() }, seven_day: { utilization: 40, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() } } }
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response } }) + '\\n')
})
`)
  chmodSync(script, 0o755)
  return bin
}

test('the usage overview shows the workspace\'s agent tokens, the breakdown and subscription limits', async () => {
  const home = makeHome()
  const project = makeProject(home)
  seedTranscripts(home, project)
  const bin = fakeClaude(home)
  app = await launchApp({ home, workspace: project, env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })
  const page = app.mainWindow

  await page.getByRole('button', { name: 'Usage' }).first().click()
  const overview = page.locator('section[aria-label="Usage overview"]')
  const header = overview.locator('header')
  const metrics = header.getByRole('group', { name: 'Usage metric' })
  const periods = header.getByRole('group', { name: 'Usage period' })
  const fade = () => header.evaluate((element) => getComputedStyle(element, '::after').backgroundImage)
  await expect(overview).toBeVisible()
  await metrics.getByRole('button', { name: 'Tokens' }).click()
  await expect(header.getByRole('button', { name: 'Refresh usage' })).toBeVisible()
  // 1.2M + 0.3M + 0.5M Claude, 1M Codex; the session elsewhere is not counted.
  await expect(overview.getByText('3M', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(overview.getByText('Claude Code').first()).toBeVisible()
  await expect(overview.getByText('Codex').first()).toBeVisible()
  await expect(overview.getByRole('cell', { name: /claude-e2e-model/ })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('usage-tokens.png') })

  await periods.getByRole('button', { name: '90 days' }).click()
  await overview.getByRole('group', { name: 'Usage breakdown' }).getByRole('button', { name: 'Day' }).click()
  await expect.poll(fade).toContain('linear-gradient')
  await overview.getByRole('row').last().scrollIntoViewIfNeeded()
  await expect(periods).toBeInViewport()

  await metrics.getByRole('button', { name: 'Limits' }).click()
  await expect(overview.getByText('75%', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(overview.getByText('60%', { exact: true }).first()).toBeVisible()
  await expect.poll(fade).toBe('none')
  await page.screenshot({ path: test.info().outputPath('usage-limits.png') })
})
