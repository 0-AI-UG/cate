import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentId } from '../../contract'
import { codexTrustedHash } from './codexTrust'
import { ensureHermesIntegration } from '../hooks/hermes'
import { runLiveCli } from '../changes/liveHarness'
import type { createHookMockProvider } from './hookMockProvider'

export const HOOK_SMOKE_PROMPT = 'Reply with only the number 41872 plus one. Do not use any tools.'

export function cleanHookEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_.*|TERM.*|TMPDIR|TMP|TEMP|SystemRoot|ComSpec|PATHEXT)$/i.test(key)
    && !/^(CATE_HOOK_|CATE_TERMINAL_ID$|CLAUDE|ANTHROPIC|CODEX|GROK_|HERMES_HOME$)/.test(key))) as Record<string, string>
}

export async function configureHookCli(agentId: AgentId, directory: string, cwd: string, env: Record<string, string>, provider: Awaited<ReturnType<typeof createHookMockProvider>>, initialPrompt = HOOK_SMOKE_PROMPT): Promise<{
  args: string[]
  close?: () => Promise<void>
}> {
  const mockUrl = provider.url
  switch (agentId) {
    case 'claude-code': {
      env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude')
      env.ANTHROPIC_BASE_URL = mockUrl
      env.ANTHROPIC_AUTH_TOKEN = 'cate-fake-key'
      env.ANTHROPIC_API_KEY = ''
      env.DISABLE_AUTOUPDATER = '1'
      await mkdir(env.CLAUDE_CONFIG_DIR)
      await writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true, theme: 'dark',
        projects: { [cwd]: { hasTrustDialogAccepted: true } },
      }))
      return { args: ['--model', 'haiku', '--setting-sources', 'project,local', initialPrompt] }
    }
    case 'codex': {
      env.CODEX_HOME = path.join(directory, 'codex')
      env.OPENROUTER_API_KEY = 'cate-fake-key'
      await mkdir(env.CODEX_HOME)
      const file = path.join(cwd, '.codex', 'hooks.json')
      const config = JSON.parse(await readFile(file, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>
      }
      const trust = Object.entries(config.hooks).map(([event, groups]) => {
        const label = event.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`)
        const hook = groups[0].hooks[0]
        return `[hooks.state.${JSON.stringify(`${file}:${label}:0:0`)}]\ntrusted_hash = ${JSON.stringify(codexTrustedHash(label, hook.command, hook.timeout))}`
      }).join('\n')
      // Trust/provider config belongs in the file, NOT -c/--profile/--no-daemon:
      // those argv overrides independently disable the shared daemon and would
      // mask a regression in Cate's envForPty workaround (#708).
      await writeFile(path.join(env.CODEX_HOME, 'config.toml'), [
        // The mock model must match Codex's bundled catalog, or apply_patch is not offered.
        'model = "openai/gpt-5.5"',
        'model_provider = "openrouter"', 'model_reasoning_effort = "low"',
        'check_for_update_on_startup = false',
        '[model_providers.openrouter]', 'name = "OpenRouter"',
        `base_url = ${JSON.stringify(`${mockUrl}/v1`)}`, 'env_key = "OPENROUTER_API_KEY"', 'wire_api = "responses"',
        `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"', trust, '',
      ].join('\n'))
      return { args: [initialPrompt] }
    }
    case 'cursor':
      env.HOME = path.join(directory, 'cursor-home')
      env.XDG_CONFIG_HOME = path.join(directory, 'cursor-xdg')
      await mkdir(env.HOME)
      env.CURSOR_CONFIG_DIR = path.join(directory, 'cursor-config')
      env.CURSOR_DATA_DIR = path.join(directory, 'cursor-data')
      env.CURSOR_API_KEY = 'cate-fake-key'
      env.AGENT_CLI_CREDENTIAL_STORE = 'memory'
      return { args: ['--trust', '--endpoint', mockUrl, '--model', 'auto', initialPrompt] }
    case 'grok': {
      env.GROK_FOLDER_TRUST = '0'
      env.GROK_HOME = path.join(directory, 'grok')
      await mkdir(env.GROK_HOME)
      await writeFile(path.join(env.GROK_HOME, 'config.toml'), [
        '[cli]', 'auto_update = false', '[features]', 'remote_fetch = false', 'telemetry = false',
        '[models]', 'default = "cate-mock"', '[model.cate-mock]', 'model = "cate-mock"',
        `base_url = ${JSON.stringify(`${mockUrl}/v1`)}`, 'api_key = "cate-fake-key"', 'api_backend = "chat_completions"',
      ].join('\n'))
      return { args: ['--no-subagents', '--disable-web-search', '--model', 'cate-mock', initialPrompt] }
    }
    case 'kiro': {
      env.HOME = path.join(directory, 'kiro-home')
      await mkdir(path.join(env.HOME, '.local/bin'), { recursive: true })
      const chatBin = await realpath(execFileSync('which', ['kiro-cli-chat'], { encoding: 'utf8' }).trim())
      await symlink(chatBin, path.join(env.HOME, '.local/bin/kiro-cli-chat'))
      env.KIRO_HOME = path.join(directory, 'kiro')
      env.KIRO_DATA_DIR = path.join(directory, 'kiro-data')
      env.KIRO_API_KEY = 'cate-fake-key'
      env.KIRO_KAS_ENDPOINT = mockUrl
      env.KIRO_KAS_CONTROL_PLANE_ENDPOINT = mockUrl
      env.KIRO_NO_AUTO_UPDATE = '1'
      return { args: ['chat', '--v3', initialPrompt] }
    }
    case 'opencode':
      env.OPENCODE_DISABLE_AUTOUPDATE = '1'
      env.XDG_CONFIG_HOME = path.join(directory, 'config')
      env.XDG_DATA_HOME = path.join(directory, 'data')
      env.XDG_STATE_HOME = path.join(directory, 'state')
      await writeFile(path.join(cwd, 'opencode.json'), JSON.stringify({
        provider: { cate: { npm: '@ai-sdk/openai-compatible', name: 'Cate mock', options: { baseURL: `${mockUrl}/v1`, apiKey: 'cate-fake-key' }, models: { 'cate-mock': { name: 'Cate mock' } } } },
      }))
      return { args: ['--model', 'cate/cate-mock', '--prompt', initialPrompt] }
    case 'hermes': {
      const profile = `cate-ci-${randomUUID().slice(0, 8)}`
      await runLiveCli('hermes', ['profile', 'create', profile, '--no-alias', '--no-skills'], { cwd, env })
      const config = await runLiveCli('hermes', ['--profile', profile, 'config', 'path'], { cwd, env })
      const profileDir = path.dirname(config.stdout.trim())
      if (!path.isAbsolute(profileDir) || path.basename(profileDir) !== profile) throw new Error('Unexpected disposable Hermes profile path')
      // No alias, copied account state, or gateway is created. Delete only our
      // exact disposable directory; upstream profile delete currently reports
      // a purge-identity error after it has already removed that directory.
      const close = () => rm(profileDir, { recursive: true, force: true })
      try {
        await ensureHermesIntegration(profile)
        env.CUSTOM_BASE_URL = `${mockUrl}/v1`
        env.CUSTOM_API_KEY = 'cate-fake-key'
        return { args: ['--profile', profile, 'chat', '--cli', '--provider', 'custom',
          '--model', 'cate-mock', '--query', initialPrompt], close }
      } catch (error) { await close(); throw error }
    }
  }
}
