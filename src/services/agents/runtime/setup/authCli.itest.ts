import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, test } from 'vitest'
import { AGENT_DEFS } from '../../contract'
import { cleanHookEnv } from '../live/hookCliFixture'
import { selectHookSmokeAgents } from '../live/hookSmoke.config'
import { AGENT_SETUP_ADAPTERS, setupAuthentication } from './adapters'
import { runLiveTui } from '../changes/liveHarness'
import { createSetupFixture } from './setupFixture'

/** Status commands legitimately exit nonzero when signed out. Keep the exit
 * code, and parse the same stdout/stderr choice used by the setup service. */
function invoke(command: string, args: readonly string[], env: Record<string, string>, cwd: string, stdin?: string) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = execFile(command, [...args], { cwd, env, timeout: 12_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return }
      resolve({ code: error ? Number(error.code) : 0, output: stripVTControlCharacters(stdout.trim() || stderr.trim()) })
    })
    child.stdin?.end(stdin)
  })
}

const selected = selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS)
describe.runIf(process.env.CATE_LIVE_AGENT_CLIS === '1')('installed CLI authentication contract', () => {
  test.each(selected.filter((id) => id === 'claude-code' || id === 'codex'))('%s recognizes stored subscription credentials, API authentication, and the subscription again', async (agentId) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cate-subscription-cli-'))
    const configDir = path.join(home, 'config')
    await mkdir(configDir)
    const env: Record<string, string> = { ...cleanHookEnv(), HOME: home, CODEX_HOME: configDir, CLAUDE_CONFIG_DIR: configDir }
    // Synthetic, unvalidated OAuth tokens: this tests local CLI credential
    // selection/status, not hosted authorization or subscription entitlement.
    const claims = { email: 'subscriber@example.test', exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'fixture-account' } }
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`
    const file = path.join(configDir, agentId === 'codex' ? 'auth.json' : '.credentials.json')
    const subscription = JSON.stringify(agentId === 'codex'
      ? { auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'fixture-refresh', account_id: 'fixture-account' }, last_refresh: '2099-01-01T00:00:00Z' }
      : { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 4102444800000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } })
    const command = AGENT_DEFS[agentId].command
    const status = async () => {
      const result = await invoke(command, AGENT_SETUP_ADAPTERS[agentId].status!, env, home)
      expect(result.code).toBe(0)
      expect(setupAuthentication(agentId, result.output, result.code).status).toBe('signed-in')
      return result.output
    }
    try {
      await writeFile(file, subscription)
      expect(await status()).toMatch(agentId === 'codex' ? /ChatGPT/ : /claude.ai/)
      if (agentId === 'codex') expect((await invoke(command, ['login', '--with-api-key'], env, home, 'fixture-api-key\n')).code).toBe(0)
      else env.ANTHROPIC_API_KEY = 'fixture-api-key'
      expect(await status()).toMatch(agentId === 'codex' ? /API key configured|API key/i : /api_key/)
      if (agentId === 'codex') await writeFile(file, subscription)
      else delete env.ANTHROPIC_API_KEY
      expect(await status()).toMatch(agentId === 'codex' ? /ChatGPT/ : /claude.ai/)
      expect(await readFile(file, 'utf8')).toBe(subscription)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  test.runIf(selected.includes('pi'))('Pi setup prepares its native /login editor without sending a model prompt', { timeout: 30_000 }, async () => {
    const fixture = await createSetupFixture()
    try {
      const operation = await fixture.setup.begin({ agentId: 'pi', action: 'login' })
      const plan = await fixture.launch.get('agents.setup')!({ operationId: operation.id }, { cwd: fixture.root, panelId: operation.panelId! })
      const home = path.join(fixture.root, 'pi-home')
      await mkdir(home)
      await runLiveTui(plan.command!.executable, plan.command!.args, {
        cwd: fixture.root, env: { ...cleanHookEnv(), HOME: fixture.root, PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1' },
        timeout: 15_000, renderScreen: true,
        complete: (screen) => screen.includes('/login') && screen.includes('Press Enter to sign in'),
      })
    } finally { await fixture.close() }
  })
  test.each(selected.filter((id) => id !== 'pi'))('%s accepts native login flags and reports an isolated signed-out account', { timeout: 45_000 }, async (agentId) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cate-auth-cli-'))
    const env = {
      ...cleanHookEnv(), HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
      CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CURSOR_CONFIG_DIR: path.join(home, 'cursor'), CURSOR_DATA_DIR: path.join(home, 'cursor-data'), AGENT_CLI_CREDENTIAL_STORE: 'memory',
      KIRO_HOME: path.join(home, 'kiro'), KIRO_DATA_DIR: path.join(home, 'kiro-data'), GROK_HOME: path.join(home, 'grok'),
      PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), PI_OFFLINE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', DISABLE_AUTOUPDATER: '1', NO_OPEN_BROWSER: '1',
    }
    try {
      await mkdir(env.CODEX_HOME); await mkdir(env.CLAUDE_CONFIG_DIR)
      const adapter = AGENT_SETUP_ADAPTERS[agentId]
      const command = AGENT_DEFS[agentId].command
      const help = await invoke(command, [...adapter.login, '--help'], env, home)
      expect(help.code).toBe(0)
      expect(help.output).toMatch(/log ?in|sign in|authenticate/i)
      for (const flag of adapter.login.filter((arg) => arg.startsWith('--'))) expect(help.output).toContain(flag)
      if (!adapter.status) {
        expect(['grok']).toContain(agentId) // No invented whoami/config-token heuristic.
        return
      }
      const signedOut = await invoke(command, adapter.status, env, home)
      expect(setupAuthentication(agentId, signedOut.output, signedOut.code).status).toBe('signed-out')
      // Exercise CLI-owned API credential persistence, without authenticating
      // against an upstream account or changing the developer's real home.
      if (agentId === 'codex') {
        expect((await invoke(command, ['login', '--with-api-key'], env, home, 'fixture-api-key\n')).code).toBe(0)
      } else if (agentId === 'claude-code') {
        Object.assign(env, { ANTHROPIC_API_KEY: 'fixture-api-key' })
      } else if (agentId === 'kiro') {
        Object.assign(env, { KIRO_API_KEY: 'fixture-api-key' })
      } else if (agentId === 'cursor') {
        Object.assign(env, { CURSOR_API_KEY: 'fixture-api-key' })
      } else if (agentId === 'opencode') {
        const dir = path.join(env.XDG_DATA_HOME, 'opencode')
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api', key: 'fixture-api-key' } }))
      } else return
      const signedIn = await invoke(command, adapter.status, env, home)
      expect(setupAuthentication(agentId, signedIn.output, signedIn.code).status).toBe(agentId === 'cursor' ? 'signed-out' : 'signed-in')
      expect(JSON.stringify(setupAuthentication(agentId, signedIn.output, signedIn.code))).not.toContain('fixture-api-key')
      const fixture = await createSetupFixture({ env: () => env, probe: undefined })
      try {
        const info = (await fixture.setup.inspect()).agents.find((agent) => agent.agentId === agentId)
        expect(info?.installation.status).toBe('installed')
        expect(info?.authentication.status).toMatch(/^(signed-in|unknown)$/)
      }
      finally { await fixture.close() }
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
