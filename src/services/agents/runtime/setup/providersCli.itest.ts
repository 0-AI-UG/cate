import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { AGENT_DEFS } from '../../contract'
import { cleanHookEnv } from '../live/hookCliFixture'
import { createHookMockProvider } from '../live/hookMockProvider'
import { runLiveCli } from '../changes/liveHarness'
import { createSetupFixture } from './setupFixture'
import { selectHookSmokeAgents } from '../live/hookSmoke.config'
import { AGENT_SETUP_ADAPTERS } from './adapters'

/** Real installed executables, production launch preparation, isolated native
 * homes, and a local mock provider. No upstream account or paid model is used. */
describe.runIf(process.env.CATE_LIVE_AGENT_CLIS === '1')('Custom provider native CLI routing', () => {
  test.each(selectHookSmokeAgents(process.env.CATE_HOOK_SMOKE_AGENTS))('%s honors API support and switches native API → configured provider → native API', { timeout: 120_000 }, async (agentId) => {
    if (!AGENT_SETUP_ADAPTERS[agentId].apiProtocol) {
      const fixture = await createSetupFixture()
      try {
        await expect(fixture.setup.configure({ agentId, connection: 'api' })).rejects.toThrow(AGENT_SETUP_ADAPTERS[agentId].apiReason)
        expect((await fixture.setup.configure({ agentId, connection: 'native' })).connection).toBe('native')
      } finally { await fixture.close() }
      return
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cate-provider-cli-'))
    let rejectProvider: number | false = false
    const provider = await createHookMockProvider({ reply: () => rejectProvider ? { type: 'error', status: rejectProvider } : { type: 'text' } })
    const native = await createHookMockProvider()
    const fixture = await createSetupFixture()
    try {
      const cwd = path.join(directory, 'repo')
      const home = path.join(directory, 'home')
      await mkdir(cwd)
      await mkdir(home)
      const env: Record<string, string> = {
        ...cleanHookEnv(), HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
        CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), PI_OFFLINE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', GROK_FOLDER_TRUST: '0',
      }
      await mkdir(env.CODEX_HOME, { recursive: true })
      await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
      await writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } }))
      const prompt = 'Reply with a short greeting. Do not use any tools.'
      const args = agentId === 'claude-code' ? ['--print', '--setting-sources', 'project,local', prompt]
        : agentId === 'codex' ? ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', prompt]
        : agentId === 'opencode' ? ['run', '--format', 'json', prompt]
        : agentId === 'pi' ? ['--print', '--no-extensions', '--no-skills', '--no-context-files', prompt]
        : ['--no-subagents', '--single', prompt]
      const command = { executable: AGENT_DEFS[agentId].command, args }
      const credential = 'fixture-api-key'
      const model = 'fixture-model'
      const nativeFiles: string[] = []
      env.NATIVE_API_KEY = 'native-fixture-key'
      if (agentId === 'claude-code') {
        Object.assign(env, { ANTHROPIC_BASE_URL: native.url, ANTHROPIC_AUTH_TOKEN: env.NATIVE_API_KEY })
        const file = path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json')
        await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'unused-subscription-token', refreshToken: 'unused-refresh-token', expiresAt: Date.now() + 3_600_000 } }))
        nativeFiles.push(file)
      } else if (agentId === 'codex') {
        const file = path.join(env.CODEX_HOME, 'config.toml')
        await writeFile(file, `model_provider = "native"\nmodel = "${model}"\n[model_providers.native]\nname = "Native fixture"\nbase_url = "${native.url}/v1"\nenv_key = "NATIVE_API_KEY"\nwire_api = "responses"\n`)
        nativeFiles.push(file)
        const auth = path.join(env.CODEX_HOME, 'auth.json')
        await writeFile(auth, JSON.stringify({ OPENAI_API_KEY: 'unused-saved-api-key' }))
        nativeFiles.push(auth)
      } else if (agentId === 'opencode') {
        const file = path.join(cwd, 'opencode.json')
        await writeFile(file, JSON.stringify({ model: `native/${model}`, small_model: `native/${model}`, provider: { native: { npm: '@ai-sdk/openai-compatible', name: 'Native fixture', options: { baseURL: `${native.url}/v1`, apiKey: env.NATIVE_API_KEY }, models: { [model]: { name: model } } } } }))
        nativeFiles.push(file)
      } else if (agentId === 'pi') {
        await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true })
        const models = path.join(env.PI_CODING_AGENT_DIR, 'models.json')
        await writeFile(models, JSON.stringify({ providers: { native: { baseUrl: `${native.url}/v1`, api: 'openai-completions', apiKey: '$NATIVE_API_KEY', authHeader: true, models: [{ id: model }] } } }))
        const settings = path.join(env.PI_CODING_AGENT_DIR, 'settings.json')
        await writeFile(settings, JSON.stringify({ defaultProvider: 'native', defaultModel: model, retry: { enabled: false } }))
        nativeFiles.push(models, settings)
      } else if (agentId === 'grok') {
        env.GROK_HOME = path.join(home, '.grok')
        await mkdir(env.GROK_HOME)
        const file = path.join(env.GROK_HOME, 'config.toml')
        await writeFile(file, `[cli]\nauto_update = false\n[features]\nremote_fetch = false\n[models]\ndefault = "native"\n[model.native]\nmodel = "${model}"\nbase_url = "${native.url}/v1"\nenv_key = "NATIVE_API_KEY"\napi_backend = "chat_completions"\n`)
        nativeFiles.push(file)
      }
      const initial = await fixture.setup.prepareLaunch(agentId, command)
      const baseline = await runLiveCli(initial.command!.executable, initial.command!.args, { cwd, env: { ...env, ...initial.env }, timeout: 30_000 })
      expect(baseline.stdout + baseline.stderr).toContain(native.answer)
      expect(native.inferenceAuthorization).toContain('Bearer native-fixture-key')
      // CLIs own these files and may normalize them on first launch. Capture
      // after native startup, then verify Cate never rewrites their settings.
      const before = await Promise.all(nativeFiles.map((file) => readFile(file, 'utf8')))
      const configured = await fixture.setup.providers.save({ name: 'Fixture provider', baseUrl: agentId === 'claude-code' ? provider.url : `${provider.url}/v1`, api: AGENT_SETUP_ADAPTERS[agentId].apiProtocol!, apiKey: credential, models: [{ id: model }] })
      await fixture.setup.configure({ agentId, connection: 'api', providerId: configured.id, model })
      const configuredSessionId = randomUUID()
      const configuredCommand = agentId === 'pi' ? { ...command, args: ['--session-id', configuredSessionId, ...command.args] } : command
      const plan = await fixture.setup.prepareLaunch(agentId, configuredCommand)
      expect(JSON.stringify(plan.command)).not.toContain(credential)
      // A runtime can inherit keys and alternate provider flags from its shell.
      // The explicit provider plan must take precedence over all of them.
      const providerEnv = { ...env, OPENAI_API_KEY: 'wrong-api-key', ANTHROPIC_API_KEY: 'wrong-api-key', CLAUDE_CODE_OAUTH_TOKEN: 'wrong-oauth-token', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', XAI_API_KEY: 'wrong-api-key', GROK_CODE_XAI_API_KEY: 'wrong-api-key', ...plan.env }
      if (agentId === 'grok') await writeFile(path.join(plan.env!.GROK_HOME, 'config.toml'), '\n[cli]\nauto_update = false\n', { flag: 'a' })
      const result = await runLiveCli(plan.command!.executable, plan.command!.args, { cwd, env: providerEnv, timeout: 50_000 })
      expect(provider.modelInputs.length, 'the CLI sent an inference request to the configured provider').toBeGreaterThan(0)
      expect(result.stdout + result.stderr).toContain(provider.answer)
      expect(provider.modelInputs.every(({ input }) => input.model === model)).toBe(true)
      expect(provider.inferenceAuthorization.every((value) => value === `Bearer ${credential}`)).toBe(true)
      expect(await Promise.all(nativeFiles.map((file) => readFile(file, 'utf8')))).toEqual(before)
      if (agentId === 'pi') {
        const extension = plan.command!.args[plan.command!.args.indexOf('--extension') + 1]
        const beforeFailure = { native: native.modelInputs.length, configured: provider.modelInputs.length }
        await rename(extension, `${extension}.unavailable`)
        try {
          const failed = await runLiveCli(plan.command!.executable, plan.command!.args, { cwd, env: providerEnv, timeout: 15_000 }).then((r) => r.stdout + r.stderr, String)
          expect(failed).not.toContain(provider.answer)
          expect(native.modelInputs.length).toBe(beforeFailure.native)
          expect(provider.modelInputs.length).toBe(beforeFailure.configured)
        } finally { await rename(`${extension}.unavailable`, extension) }
      }
      const restoreCommand = agentId === 'pi' ? { ...command, args: ['--session', configuredSessionId, ...command.args] } : command
      const restoredPlan = await fixture.setup.prepareLaunch(agentId, restoreCommand)
      expect(restoredPlan.env?.CATE_PROVIDER_API_KEY).toBe(plan.env?.CATE_PROVIDER_API_KEY)
      const nativeBeforeRestore = native.modelInputs.length
      const resumed = await runLiveCli(restoredPlan.command!.executable, restoredPlan.command!.args, { cwd, env: { ...env, ...restoredPlan.env }, timeout: 30_000 })
      expect(resumed.stdout + resumed.stderr).toContain(provider.answer)
      expect(native.modelInputs.length).toBe(nativeBeforeRestore)
      for (const rejection of agentId === 'pi' ? [401, 402, 429, 503] : [400]) {
        rejectProvider = rejection
        const requestsBeforeFailure = provider.modelInputs.length
        // Some CLIs return an error event with exit 0; others exit nonzero.
        const failure = await runLiveCli(plan.command!.executable, plan.command!.args, { cwd, env: providerEnv, timeout: 15_000 }).then((r) => r.stdout + r.stderr, (error: unknown) => String(error))
        expect(failure).not.toContain(provider.answer)
        expect(provider.modelInputs.length).toBeGreaterThan(requestsBeforeFailure)
        expect(native.modelInputs.length).toBe(nativeBeforeRestore)
        rejectProvider = false
      }
      await fixture.setup.configure({ agentId, connection: 'native' })
      const back = await fixture.setup.prepareLaunch(agentId, command)
      expect(back).toEqual({ command })
      const nativeCount = native.modelInputs.length
      const configuredCount = provider.modelInputs.length
      const resultBack = await runLiveCli(back.command!.executable, back.command!.args, { cwd, env: { ...env, ...back.env }, timeout: 30_000 })
      expect(resultBack.stdout + resultBack.stderr).toContain(native.answer)
      expect(native.modelInputs.length).toBeGreaterThan(nativeCount)
      expect(provider.modelInputs.length).toBe(configuredCount)
      expect(await Promise.all(nativeFiles.map((file) => readFile(file, 'utf8')))).toEqual(before)
    } finally {
      await fixture.close()
      await native.close()
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
