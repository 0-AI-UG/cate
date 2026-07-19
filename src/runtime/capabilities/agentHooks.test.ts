// =============================================================================
// Daemon-side agent hooks capability tests — the REAL implementation, no
// mocks: the hooks dir materializes on disk, the loopback ingestion endpoint
// runs, the generated bridge executes under /bin/sh, and workspace
// preparation writes/merges project hook files. POSIX-only mechanisms (the
// capability itself no-ops on win32).
// =============================================================================

import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createAgentHooksCapability, ensureGitExcluded, type AgentHooksCapability } from './agentHooks'
import type { AgentHookEvent } from '../../shared/agentHooks'

const posix = process.platform !== 'win32'

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try { fn() } catch { /* best-effort */ }
  }
})

function tmpDir(sub: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cate-hooks-test-${sub}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Every test capability gets its OWN hooks dir (the production default is a
 *  fixed per-user dir — sharing it across tests would leak state and files
 *  into the real ~/.cate). */
function makeCap(deps: { hasBin?: (c: string) => Promise<boolean>; hooksDir?: string } = {}): AgentHooksCapability {
  const cap = createAgentHooksCapability({ hooksDir: tmpDir('stable'), ...deps })
  cleanups.push(() => cap.dispose())
  return cap
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
  test('envForPty plants the hook env and ambient opencode config', async () => {
    const cap = makeCap()
    const env = await cap.envForPty('rpty-1-local', { PATH: '/usr/bin:/bin', HOME: '/home/u' })

    expect(env.CATE_TERMINAL_ID).toBe('rpty-1-local')
    expect(env.CATE_HOOK_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(env.CATE_HOOK_TOKEN).toMatch(/^[0-9a-f]{48}$/)
    // Untouched caller env survives — including PATH: injection is file/env
    // only, so nothing is prepended.
    expect(env.HOME).toBe('/home/u')
    expect(env.PATH).toBe('/usr/bin:/bin')

    // opencode ambient config: a plugin file that exists on disk.
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { plugin: string[] }
    expect(config.plugin[0]).toMatch(/^file:\/\//)
    expect(existsSync(config.plugin[0].slice('file://'.length))).toBe(true)

    // An env var the caller already set is never clobbered by ambient vars.
    const env2 = await cap.envForPty('rpty-2-local', { PATH: '/bin', OPENCODE_CONFIG_CONTENT: 'user-value' })
    expect(env2.OPENCODE_CONFIG_CONTENT).toBe('user-value')
  })

  test('a failed setup yields a plain shell, then a retry on the same dir succeeds', async () => {
    // Fail setup at the endpoint bind — the last setup step, so the stable
    // dir is already partially built. That partial dir is harmless (stale
    // files are overwritten) and the retry must reuse it.
    const serverSpy = vi.spyOn(http, 'createServer').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    try {
      const cap = makeCap()
      const env = await cap.envForPty('rpty-fail', { PATH: '/bin' })
      expect(env).toEqual({ PATH: '/bin' }) // failed setup → plain shell
      // The reset retries setup on the next PTY create — and now succeeds.
      const env2 = await cap.envForPty('rpty-retry', { PATH: '/bin' })
      expect(env2.CATE_HOOK_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      serverSpy.mockRestore()
    }
  })

  test('the bridge path is stable across capability restarts (repo hook files embed it)', async () => {
    // Requirement pinned by codex trust: hooks.json embeds the bridge path,
    // and codex's persisted hook trust hashes over it — a per-boot path would
    // rewrite user repos and re-prompt "modified since last trusted" on
    // every app restart. Two setup cycles over the same stable dir must
    // yield byte-identical bridge locations.
    const stable = tmpDir('stable-reuse')
    const cap1 = createAgentHooksCapability({ hooksDir: stable })
    const { dir: dir1 } = await cap1.endpoint()
    expect(dir1).toBe(stable)
    const bridge1 = path.join(dir1, 'cate-hook-bridge-codex')
    expect(existsSync(bridge1)).toBe(true)
    cap1.dispose()
    // dispose keeps the dir — the embedded paths must survive restarts.
    expect(existsSync(bridge1)).toBe(true)

    const cap2 = createAgentHooksCapability({ hooksDir: stable })
    cleanups.push(() => cap2.dispose())
    const { dir: dir2 } = await cap2.endpoint()
    expect(dir2).toBe(dir1)
    expect(existsSync(path.join(dir2, 'cate-hook-bridge-codex'))).toBe(true)
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
          // No stdout on purpose — every CLI accepts silent exit-0.
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

  test('prepareWorkspace writes the claude + codex + pi hook files and git-excludes them', async () => {
    const cap = makeCap({ hasBin: async () => true })
    const cwd = tmpDir('ws')
    mkdirSync(path.join(cwd, '.git')) // enough of a repo for info/exclude

    await cap.prepareWorkspace(cwd)

    const claudeSettings = JSON.parse(readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8')) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(claudeSettings.hooks)).toContain('SessionStart')
    expect(Object.keys(claudeSettings.hooks)).toContain('Stop')

    // codex discovers <project>/.codex/hooks.json itself (repo scope) — the
    // command must be the stable bridge path, with codex's timeout field.
    const codexHooks = JSON.parse(readFileSync(path.join(cwd, '.codex', 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>
    }
    expect(Object.keys(codexHooks.hooks)).toContain('PermissionRequest')
    const { dir } = await cap.endpoint()
    expect(codexHooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
      command: path.join(dir, 'cate-hook-bridge-codex'),
      timeout: 60,
    })

    // pi's extension is auto-discovered from <cwd>/.pi/extensions — self-gated
    // on the hook env, so it is inert outside Cate terminals.
    const piExt = readFileSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'), 'utf-8')
    expect(piExt).toContain('CATE_HOOK_ENDPOINT')

    const exclude = readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude).toContain('/.claude/settings.local.json')
    expect(exclude).toContain('/.codex/hooks.json')
    expect(exclude).toContain('/.pi/extensions/cate-hook.ts')

    // Idempotent: a second prepare does not duplicate exclude lines.
    await cap.prepareWorkspace(cwd)
    const exclude2 = readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude2.split('\n').filter((l) => l === '/.claude/settings.local.json').length).toBe(1)
    expect(exclude2.split('\n').filter((l) => l === '/.codex/hooks.json').length).toBe(1)
    expect(exclude2.split('\n').filter((l) => l === '/.pi/extensions/cate-hook.ts').length).toBe(1)
  })

  test('prepareWorkspace never touches the user home dir or a non-absolute cwd', async () => {
    // ~/.codex and ~/.claude are the CLIs' USER-GLOBAL config dirs — writing
    // agent files there is exactly the policy this guard enforces. The guard
    // must bail before ANY file work, so the hasBin probe (the first step of
    // the per-agent loop) is the observable tripwire.
    const probed: string[] = []
    const cap = makeCap({
      hasBin: async (c) => {
        probed.push(c)
        return true
      },
    })
    await cap.prepareWorkspace(os.homedir())
    await cap.prepareWorkspace(os.homedir() + path.sep) // trailing-slash spelling
    await cap.prepareWorkspace('')
    await cap.prepareWorkspace('relative/path')
    expect(probed).toEqual([])

    // Sanity: the same capability still prepares a real workspace.
    const cwd = tmpDir('ws-guard')
    await cap.prepareWorkspace(cwd)
    expect(probed.length).toBeGreaterThan(0)
    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(true)
  })

  test('prepareWorkspace leaves other files in .pi/extensions alone and reclaims a drifted cate-hook.ts', async () => {
    const cap = makeCap({ hasBin: async () => true })
    const cwd = tmpDir('ws-pi')
    mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true })
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'user-ext.ts'), '// mine\n')
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'), '// stale or edited\n')

    await cap.prepareWorkspace(cwd)

    expect(readFileSync(path.join(cwd, '.pi', 'extensions', 'user-ext.ts'), 'utf-8')).toBe('// mine\n')
    // Cate owns cate-hook.ts outright — drifted content is rewritten.
    expect(readFileSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'), 'utf-8')).toContain('CATE_HOOK_ENDPOINT')
  })

  test('prepareWorkspace never clobbers unparseable user hook files and skips absent CLIs', async () => {
    const capAll = makeCap({ hasBin: async () => true })
    const cwd = tmpDir('ws2')
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{broken json')
    await capAll.prepareWorkspace(cwd)
    expect(readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8')).toBe('{broken json')

    const capNone = makeCap({ hasBin: async () => false })
    const cwd2 = tmpDir('ws3')
    await capNone.prepareWorkspace(cwd2)
    expect(existsSync(path.join(cwd2, '.claude'))).toBe(false)
    expect(existsSync(path.join(cwd2, '.codex'))).toBe(false)
    expect(existsSync(path.join(cwd2, '.pi'))).toBe(false)
  })

  test('subscribe/unsubscribe stops delivery; dispose keeps the stable hooks dir', async () => {
    const cap = createAgentHooksCapability({ hooksDir: tmpDir('dispose') })
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
    const env = await cap.envForPty('t2', { PATH: '/bin' })
    expect(env).toEqual({ PATH: '/bin' }) // disposed → plain env
    // The dir survives dispose: repo hook files embed its bridge paths.
    expect(existsSync(dir)).toBe(true)
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

    await ensureGitExcluded(wt, ['.claude/settings.local.json'])
    const exclude = readFileSync(path.join(mainGit, 'info', 'exclude'), 'utf-8')
    expect(exclude).toContain('/.claude/settings.local.json')
  })

  test('a non-repo cwd is a silent no-op', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cate-hooks-norepo-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    await expect(ensureGitExcluded(dir, ['.claude/settings.local.json'])).resolves.toBeUndefined()
    expect(existsSync(path.join(dir, '.git'))).toBe(false)
  })
})
