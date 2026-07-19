// =============================================================================
// Daemon-side agent hooks capability tests — the REAL implementation, no
// mocks: hooks dir + shims materialize on disk, the loopback ingestion
// endpoint runs, the generated bridge and PATH shims execute under /bin/sh,
// and workspace preparation writes/merges project hook files. POSIX-only
// mechanisms (the capability itself no-ops on win32).
// =============================================================================

import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createAgentHooksCapability, ensureGitExcluded, type AgentHooksCapability } from './agentHooks'
import type { AgentHookEvent } from '../../shared/agentHooks'

const posix = process.platform !== 'win32'

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try { fn() } catch { /* best-effort */ }
  }
})

function makeCap(deps: { hasBin?: (c: string) => Promise<boolean>; homeDir?: () => string } = {}): AgentHooksCapability {
  const cap = createAgentHooksCapability(deps)
  cleanups.push(() => cap.dispose())
  return cap
}

function tmpDir(sub: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cate-hooks-test-${sub}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function collect(cap: AgentHooksCapability): AgentHookEvent[] {
  const events: AgentHookEvent[] = []
  cleanups.push(cap.subscribe((e) => events.push(e)))
  return events
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const post = (url: string, token: string | null, body: unknown): Promise<Response> =>
  fetch(`${url}/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

describe.skipIf(!posix)('agentHooks capability', () => {
  test('envForPty plants the hook env, ambient opencode config, and PATH shims', async () => {
    const cap = makeCap()
    const env = await cap.envForPty('rpty-1-local', { PATH: '/usr/bin:/bin', HOME: '/home/u' })

    expect(env.CATE_TERMINAL_ID).toBe('rpty-1-local')
    expect(env.CATE_HOOK_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(env.CATE_HOOK_TOKEN).toMatch(/^[0-9a-f]{48}$/)
    // Untouched caller env survives.
    expect(env.HOME).toBe('/home/u')

    // Shim dir first on PATH, holding executable shims for the argv-injected CLIs.
    const binDir = env.PATH.split(path.delimiter)[0]
    expect(env.PATH.endsWith('/usr/bin:/bin')).toBe(true)
    for (const cmd of ['claude', 'codex', 'pi']) {
      const st = statSync(path.join(binDir, cmd))
      expect(st.mode & 0o111, `${cmd} shim executable`).toBeTruthy()
    }
    // No shims for the project-file/env agents.
    expect(existsSync(path.join(binDir, 'cursor-agent'))).toBe(false)
    expect(existsSync(path.join(binDir, 'opencode'))).toBe(false)

    // opencode ambient config: a plugin file that exists on disk.
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { plugin: string[] }
    expect(config.plugin[0]).toMatch(/^file:\/\//)
    expect(existsSync(config.plugin[0].slice('file://'.length))).toBe(true)

    // An env var the caller already set is never clobbered by ambient vars.
    const env2 = await cap.envForPty('rpty-2-local', { PATH: '/bin', OPENCODE_CONFIG_CONTENT: 'user-value' })
    expect(env2.OPENCODE_CONFIG_CONTENT).toBe('user-value')
  })

  test('ingestion: valid posts emit normalized events; bad token / unknown payloads do not', async () => {
    const cap = makeCap()
    const events = collect(cap)
    const { url, token } = await cap.endpoint()

    const claudeStart = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: '11111111-2222-4333-8444-555555555555',
      transcript_path: '/h/.claude/projects/x/1.jsonl',
      cwd: '/w',
    }
    expect((await post(url, token, { agentId: 'claude-code', terminalId: 'rpty-9', payload: claudeStart })).status).toBe(204)
    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchObject({
      terminalId: 'rpty-9',
      agentId: 'claude-code',
      kind: 'session-start',
      sessionId: claudeStart.session_id,
      cwd: '/w',
    })

    // Wrong/missing token → rejected, no event.
    expect((await post(url, 'not-the-token', { agentId: 'claude-code', terminalId: 'rpty-9', payload: claudeStart })).status).toBe(401)
    expect((await post(url, null, { agentId: 'claude-code', terminalId: 'rpty-9', payload: claudeStart })).status).toBe(401)
    // Unknown agent / untracked payload / missing terminal id → accepted, dropped.
    await post(url, token, { agentId: 'nope', terminalId: 'rpty-9', payload: claudeStart })
    await post(url, token, { agentId: 'claude-code', terminalId: 'rpty-9', payload: { hook_event_name: 'PreToolUse' } })
    await post(url, token, { agentId: 'claude-code', terminalId: '', payload: claudeStart })
    await new Promise((r) => setTimeout(r, 100))
    expect(events.length).toBe(1)
  })

  test('the generated bridge posts a stdin payload end-to-end (sh wrapper → node → HTTP)', async () => {
    const cap = makeCap()
    const events = collect(cap)
    const { dir } = await cap.endpoint()
    const env = await cap.envForPty('rpty-bridge', { PATH: '/usr/bin:/bin' })

    const bridge = path.join(dir, 'cate-hook-bridge-codex')
    const payload = {
      hook_event_name: 'PermissionRequest',
      session_id: '99999999-1111-4222-8333-444444444444',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_input: { command: 'touch needs-approval.txt' },
      cwd: '/w',
    }
    await new Promise<void>((resolve, reject) => {
      const child = execFile(bridge, [], { env, timeout: 15_000 }, (err, stdout) => {
        if (err) reject(err)
        else {
          // No stdout on purpose — agy denies tool calls on non-allow output.
          expect(stdout).toBe('')
          resolve()
        }
      })
      child.stdin!.end(JSON.stringify(payload))
    })
    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchObject({
      terminalId: 'rpty-bridge',
      agentId: 'codex',
      kind: 'permission-wait',
      sessionId: payload.session_id,
    })
    expect(events[0].raw.turn_id).toBe('turn-1')
  })

  test('the claude PATH shim execs the real binary with injection args and honors preassign', async () => {
    const cap = makeCap()
    const env = await cap.envForPty('rpty-shim', { PATH: '/usr/bin:/bin' })

    // A fake `claude` later in PATH records its argv.
    const fakeBin = tmpDir('fakebin')
    const argvFile = path.join(fakeBin, 'argv.txt')
    writeFileSync(
      path.join(fakeBin, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\n`,
      { mode: 0o755 },
    )
    const run = (extraEnv: Record<string, string>, userArgs: string[]): Promise<string[]> =>
      new Promise((resolve, reject) => {
        execFile(
          'claude',
          userArgs,
          { env: { ...env, ...extraEnv, PATH: `${env.PATH.split(path.delimiter)[0]}${path.delimiter}${fakeBin}${path.delimiter}/usr/bin:/bin` }, timeout: 15_000 },
          (err) => {
            if (err) reject(err)
            else resolve(readFileSync(argvFile, 'utf-8').split('\n').filter(Boolean))
          },
        )
      })

    // Plain launch: NO injected argv (claude's hooks ride the project file —
    // the shim is bypassable, so nothing load-bearing may depend on it).
    const argv = await run({}, ['--model', 'haiku'])
    expect(argv).toEqual(['--model', 'haiku'])

    // Preassign env set → --session-id injected ahead of user args.
    const assigned = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const argv2 = await run({ CATE_SESSION_PREASSIGN_CLAUDE_CODE: assigned }, ['-p', 'hi'])
    expect(argv2).toEqual(['--session-id', assigned, '-p', 'hi'])

    // …but a session-affecting user flag disables preassignment.
    const argv3 = await run({ CATE_SESSION_PREASSIGN_CLAUDE_CODE: assigned }, ['--resume', assigned])
    expect(argv3).not.toContain('--session-id')
    expect(argv3).toEqual(['--resume', assigned])
  })

  test('prepareWorkspace writes claude/cursor/agy hook files, git-excludes them, and seeds agy trust', async () => {
    const home = tmpDir('home')
    mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    const cap = makeCap({ hasBin: async () => true, homeDir: () => home })
    const cwd = tmpDir('ws')
    mkdirSync(path.join(cwd, '.git')) // enough of a repo for info/exclude

    await cap.prepareWorkspace(cwd)

    const claudeSettings = JSON.parse(readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8')) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(claudeSettings.hooks)).toContain('SessionStart')
    expect(Object.keys(claudeSettings.hooks)).toContain('Stop')
    const cursorHooks = JSON.parse(readFileSync(path.join(cwd, '.cursor', 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    expect(Object.keys(cursorHooks.hooks).sort()).toEqual(['beforeSubmitPrompt', 'sessionEnd', 'sessionStart', 'stop'].sort())
    const agyHooks = JSON.parse(readFileSync(path.join(cwd, '.agents', 'hooks.json'), 'utf-8')) as Record<string, unknown>
    expect(Object.keys(agyHooks)).toEqual(['cate-hook-bridge'])

    const exclude = readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude).toContain('/.claude/settings.local.json')
    expect(exclude).toContain('/.cursor/hooks.json')
    expect(exclude).toContain('/.agents/hooks.json')

    const settings = JSON.parse(readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf-8')) as {
      trustedWorkspaces: string[]
    }
    expect(settings.trustedWorkspaces).toContain(cwd)

    // Idempotent: a second prepare neither duplicates exclude lines nor trust.
    await cap.prepareWorkspace(cwd)
    const exclude2 = readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude2.split('\n').filter((l) => l === '/.cursor/hooks.json').length).toBe(1)
    const settings2 = JSON.parse(readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf-8')) as {
      trustedWorkspaces: string[]
    }
    expect(settings2.trustedWorkspaces.filter((w) => w === cwd).length).toBe(1)
  })

  test('prepareWorkspace never clobbers unparseable user hook files and skips absent CLIs', async () => {
    const home = tmpDir('home2')
    const capAll = makeCap({ hasBin: async () => true, homeDir: () => home })
    const cwd = tmpDir('ws2')
    mkdirSync(path.join(cwd, '.cursor'), { recursive: true })
    writeFileSync(path.join(cwd, '.cursor', 'hooks.json'), '{broken json')
    await capAll.prepareWorkspace(cwd)
    expect(readFileSync(path.join(cwd, '.cursor', 'hooks.json'), 'utf-8')).toBe('{broken json')
    // agy trust untouched: its config dir does not exist in this home.
    expect(existsSync(path.join(home, '.gemini'))).toBe(false)

    const capNone = makeCap({ hasBin: async () => false, homeDir: () => home })
    const cwd2 = tmpDir('ws3')
    await capNone.prepareWorkspace(cwd2)
    expect(existsSync(path.join(cwd2, '.cursor'))).toBe(false)
    expect(existsSync(path.join(cwd2, '.agents'))).toBe(false)
  })

  test('subscribe/unsubscribe stops delivery; dispose removes the hooks dir', async () => {
    const cap = createAgentHooksCapability()
    const { url, token, dir } = await cap.endpoint()
    const events: AgentHookEvent[] = []
    const unsub = cap.subscribe((e) => events.push(e))
    const payload = { event: 'agent_end', sessionId: 's-1', sessionFile: '/f', cwd: '/w' }
    await post(url, token, { agentId: 'pi', terminalId: 't', payload })
    await waitFor(() => events.length === 1)
    unsub()
    await post(url, token, { agentId: 'pi', terminalId: 't', payload })
    await new Promise((r) => setTimeout(r, 100))
    expect(events.length).toBe(1)

    cap.dispose()
    await waitFor(() => !existsSync(dir))
    const env = await cap.envForPty('t2', { PATH: '/bin' })
    expect(env).toEqual({ PATH: '/bin' }) // disposed → plain env
  })
})

describe.skipIf(!posix)('ensureGitExcluded', () => {
  test('resolves a worktree .git file through gitdir + commondir', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cate-hooks-wt-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    // Main repo layout with a linked worktree, no real git needed.
    const mainGit = path.join(root, 'main', '.git')
    mkdirSync(path.join(mainGit, 'worktrees', 'wt'), { recursive: true })
    const wt = path.join(root, 'wt')
    mkdirSync(wt, { recursive: true })
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(mainGit, 'worktrees', 'wt')}\n`)
    writeFileSync(path.join(mainGit, 'worktrees', 'wt', 'commondir'), '../..\n')

    await ensureGitExcluded(wt, ['.cursor/hooks.json'])
    const exclude = readFileSync(path.join(mainGit, 'info', 'exclude'), 'utf-8')
    expect(exclude).toContain('/.cursor/hooks.json')
  })

  test('a non-repo cwd is a silent no-op', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cate-hooks-norepo-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    await expect(ensureGitExcluded(dir, ['.cursor/hooks.json'])).resolves.toBeUndefined()
    expect(existsSync(path.join(dir, '.git'))).toBe(false)
  })
})
