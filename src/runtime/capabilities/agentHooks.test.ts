// =============================================================================
// Daemon-side agent hooks capability tests — the REAL implementation, no
// mocks: the hooks dir materializes on disk, the loopback ingestion endpoint
// runs, the generated bridge executes under /bin/sh, and workspace
// preparation writes/merges project hook files. The capability runs on every
// platform (win32 gets a .cmd wrapper); only the sh-wrapper exec test is
// POSIX-gated.
// =============================================================================

import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createAgentHooksCapability, ensureGitExcluded, isRepoLocalCwd, type AgentHooksCapability } from './agentHooks'
import { CATE_HOOK_MARKER, agentHookFolder, type AgentHookEvent } from '../../shared/agentHooks'

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
function makeCap(
  deps: {
    hooksDir?: string
    interruptPollMs?: number
    onPost?: (post: { terminalId: string; agentId: string; pid?: number }) => void | Promise<void>
  } = {},
): AgentHooksCapability {
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

describe('agentHooks capability', () => {
  test('envForPty plants the hook env, agent-agnostic and non-clobbering', async () => {
    const cap = makeCap()
    const env = await cap.envForPty('rpty-1-local', { PATH: '/usr/bin:/bin', HOME: '/home/u' })

    expect(env.CATE_TERMINAL_ID).toBe('rpty-1-local')
    expect(env.CATE_HOOK_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(env.CATE_HOOK_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    // Untouched caller env survives — including PATH: injection is file/env
    // only, so nothing is prepended.
    expect(env.HOME).toBe('/home/u')
    expect(env.PATH).toBe('/usr/bin:/bin')

    // Injection is workspace files only — no per-agent env is planted.
    expect(Object.keys(env).filter((k) => !k.startsWith('CATE_')).sort()).toEqual(['HOME', 'PATH'])

    const env2 = await cap.envForPty('rpty-2-local', { PATH: '/bin' })
    // The token is PER TERMINAL — one pty's env spoofs nothing for another.
    expect(env2.CATE_HOOK_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(env2.CATE_HOOK_TOKEN).not.toBe(env.CATE_HOOK_TOKEN)
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
    // The wrapper is a .cmd on win32, a bare sh script on POSIX.
    const wrapperName = posix ? 'cate-hook-bridge-codex' : 'cate-hook-bridge-codex.cmd'
    const cap1 = createAgentHooksCapability({ hooksDir: stable })
    const { dir: dir1 } = await cap1.endpoint()
    expect(dir1).toBe(stable)
    const bridge1 = path.join(dir1, wrapperName)
    expect(existsSync(bridge1)).toBe(true)
    cap1.dispose()
    // dispose keeps the dir — the embedded paths must survive restarts.
    expect(existsSync(bridge1)).toBe(true)

    const cap2 = createAgentHooksCapability({ hooksDir: stable })
    cleanups.push(() => cap2.dispose())
    const { dir: dir2 } = await cap2.endpoint()
    expect(dir2).toBe(dir1)
    expect(existsSync(path.join(dir2, wrapperName))).toBe(true)
  })

  test('ingestion: valid posts emit normalized events; bad token / unknown payloads do not', async () => {
    const cap = makeCap()
    const events = collect(cap)
    const { url, tokenFor } = await cap.endpoint()

    const claudeStart = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: '11111111-2222-4333-8444-555555555555',
      transcript_path: '/h/.claude/projects/x/1.jsonl',
      cwd: '/w',
    }
    expect((await post(url, tokenFor('rpty-9'), { agentId: 'claude-code', terminalId: 'rpty-9', payload: claudeStart })).status).toBe(204)
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
    // ANOTHER terminal's valid token → rejected: the token is bound to the
    // terminalId the post claims, so one pty's env can't forge events for a
    // different terminal.
    expect((await post(url, tokenFor('rpty-other'), { agentId: 'claude-code', terminalId: 'rpty-9', payload: claudeStart })).status).toBe(401)
    // Unknown agent / untracked payload / missing terminal id → accepted, dropped.
    await post(url, tokenFor('rpty-9'), { agentId: 'nope', terminalId: 'rpty-9', payload: claudeStart })
    await post(url, tokenFor('rpty-9'), { agentId: 'claude-code', terminalId: 'rpty-9', payload: { hook_event_name: 'PreToolUse' } })
    await post(url, tokenFor(''), { agentId: 'claude-code', terminalId: '', payload: claudeStart })
    await new Promise((r) => setTimeout(r, 100))
    expect(events.length).toBe(1)
  })

  test('onPost fires per authenticated known-agent post — awaited before the response, with the lineage pid', async () => {
    const calls: Array<{ terminalId: string; agentId: string; pid?: number }> = []
    let postSettledBeforeResponse = false
    const cap = makeCap({
      onPost: async (post) => {
        // Async on purpose: the response must WAIT for this (the bridge holds
        // its process chain alive only until it hears back).
        await new Promise((r) => setTimeout(r, 50))
        calls.push(post)
        postSettledBeforeResponse = true
      },
    })
    const events = collect(cap)
    const { url, tokenFor } = await cap.endpoint()

    const payload = { hook_event_name: 'Stop', session_id: '11111111-2222-4333-8444-555555555555', cwd: '/w' }
    const res = await post(url, tokenFor('rpty-p'), { agentId: 'claude-code', terminalId: 'rpty-p', pid: 4242, payload })
    expect(res.status).toBe(204)
    expect(postSettledBeforeResponse).toBe(true)
    expect(calls).toEqual([{ terminalId: 'rpty-p', agentId: 'claude-code', pid: 4242 }])
    await waitFor(() => events.length === 1)

    // A payload that normalizes to null still proves the agent is alive.
    await post(url, tokenFor('rpty-p'), { agentId: 'claude-code', terminalId: 'rpty-p', pid: 4242, payload: { hook_event_name: 'PreToolUse' } })
    await waitFor(() => calls.length === 2)
    expect(events.length).toBe(1) // still no normalized event

    // Missing/malformed pid → undefined (the tracker ignores it), never a crash.
    await post(url, tokenFor('rpty-p'), { agentId: 'claude-code', terminalId: 'rpty-p', pid: 'nope', payload })
    await waitFor(() => calls.length === 3)
    expect(calls[2].pid).toBeUndefined()

    // No onPost for a bad token or an unknown agent.
    await post(url, 'wrong-token', { agentId: 'claude-code', terminalId: 'rpty-p', pid: 4242, payload })
    await post(url, tokenFor('rpty-p'), { agentId: 'not-an-agent', terminalId: 'rpty-p', pid: 4242, payload })
    await new Promise((r) => setTimeout(r, 150))
    expect(calls.length).toBe(3)
  })

  test.skipIf(!posix)('the generated bridge posts a stdin payload end-to-end (sh wrapper → node → HTTP)', async () => {
    const posts: Array<{ agentId: string; pid?: number }> = []
    const cap = makeCap({ onPost: (p) => { posts.push(p) } })
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
    // The bridge reports its PARENT as the lineage pid. The sh wrapper execs
    // node in place, so the bridge's parent here is THIS test process — in
    // production it is the agent CLI (or its sh hook-command layer), which is
    // what the presence tracker walks up from.
    expect(posts).toEqual([{ terminalId: 'rpty-bridge', agentId: 'codex', pid: process.pid }])
  })

  // Cross-vendor guard. grok scans .claude/settings.local.json (and
  // .cursor/hooks.json) by default, so a grok session ALSO spawns the wrapper
  // Cate injected for claude — with a grok payload. GROK_HOOK_EVENT is a
  // reserved var grok's runner injects into every hook process it spawns, so
  // it deterministically identifies the caller: the claude wrapper must stay
  // silent when grok ran it, and the grok wrapper must stay silent when
  // anything else did. Contract pinned live in agentHookContracts.itest.ts.
  test.skipIf(!posix)('the bridge drops posts whose agent disagrees with GROK_HOOK_EVENT', async () => {
    const posts: Array<{ agentId: string }> = []
    const cap = makeCap({ onPost: (p) => { posts.push(p) } })
    const events = collect(cap)
    const { dir } = await cap.endpoint()
    const baseEnv = await cap.envForPty('rpty-guard', { PATH: '/usr/bin:/bin' })

    const fire = (agent: string, env: Record<string, string>, payload: object): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = execFile(path.join(dir, `cate-hook-bridge-${agent}`), [], { env, timeout: 15_000 },
          (err) => (err ? reject(err) : resolve()))
        child.stdin!.end(JSON.stringify(payload))
      })

    const grokPayload = { hookEventName: 'session_start', sessionId: 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', cwd: '/w' }
    const grokEnv = { ...baseEnv, GROK_HOOK_EVENT: 'session_start' }

    // grok ran the CLAUDE wrapper (compat scan) — dropped, not misattributed.
    await fire('claude-code', grokEnv, grokPayload)
    // claude ran the GROK wrapper — impossible in practice, but the guard is
    // symmetric, so this drops too.
    await fire('grok', baseEnv, grokPayload)
    expect(posts, 'neither mismatched invocation reached the daemon').toEqual([])
    expect(events).toEqual([])

    // The matching pair posts normally.
    await fire('grok', grokEnv, grokPayload)
    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchObject({ agentId: 'grok', kind: 'session-start', sessionId: grokPayload.sessionId })
    expect(posts).toEqual([{ terminalId: 'rpty-guard', agentId: 'grok', pid: process.pid }])
  })

  test('prepareWorkspace writes the claude + codex + cursor + grok + pi hook files and git-excludes them', async () => {
    const cap = makeCap()
    const cwd = tmpDir('ws')
    mkdirSync(path.join(cwd, '.git')) // enough of a repo for info/exclude
    // 'auto' (the default) injects only where the agent's config folder already
    // exists — seed all five so this covers every file writer.
    for (const id of ['claude-code', 'codex', 'cursor', 'grok', 'pi'] as const) {
      mkdirSync(path.join(cwd, agentHookFolder(id)!))
    }

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
      command: path.join(dir, posix ? 'cate-hook-bridge-codex' : 'cate-hook-bridge-codex.cmd'),
      timeout: 60,
    })

    // cursor discovers <workspace>/.cursor/hooks.json itself — its schema is
    // the flat {version, hooks: {event: [{command}]}} shape.
    const cursorHooks = JSON.parse(readFileSync(path.join(cwd, '.cursor', 'hooks.json'), 'utf-8')) as {
      version: number
      hooks: Record<string, Array<{ command: string }>>
    }
    expect(cursorHooks.version).toBe(1)
    expect(cursorHooks.hooks.sessionStart[0].command).toBe(
      path.join(dir, posix ? 'cate-hook-bridge-cursor' : 'cate-hook-bridge-cursor.cmd'),
    )

    // grok merges every *.json in <project>/.grok/hooks; Cate owns cate-hook.json
    // there. CamelCase event keys, 60s timeout, PreToolUse deliberately absent.
    const grokHooks = JSON.parse(readFileSync(path.join(cwd, '.grok', 'hooks', 'cate-hook.json'), 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>
    }
    expect(Object.keys(grokHooks.hooks)).toContain('Notification')
    expect(grokHooks.hooks.PreToolUse).toBeUndefined()
    expect(grokHooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
      command: path.join(dir, posix ? 'cate-hook-bridge-grok' : 'cate-hook-bridge-grok.cmd'),
      timeout: 60,
    })

    // pi's extension is auto-discovered from <cwd>/.pi/extensions — self-gated
    // on the hook env, so it is inert outside Cate terminals.
    const piExt = readFileSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'), 'utf-8')
    expect(piExt).toContain('CATE_HOOK_ENDPOINT')

    const exclude = readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude).toContain('/.claude/settings.local.json')
    expect(exclude).toContain('/.codex/hooks.json')
    expect(exclude).toContain('/.cursor/hooks.json')
    expect(exclude).toContain('/.grok/hooks/cate-hook.json')
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
    // agent files there is exactly the policy isRepoLocalCwd enforces.
    const home = os.homedir()
    expect(isRepoLocalCwd(home, home)).toBe(false)
    expect(isRepoLocalCwd(home + path.sep, home)).toBe(false) // trailing-slash spelling
    expect(isRepoLocalCwd('', home)).toBe(false)
    expect(isRepoLocalCwd('relative/path', home)).toBe(false)
    expect(isRepoLocalCwd(path.join(home, 'code', 'repo'), home)).toBe(true)

    const cap = makeCap()
    // The guard actually short-circuits prepareWorkspace: forcing every agent
    // 'on' would otherwise write into home, so a clean home subtree proves it.
    const forceOn = { 'claude-code': 'on', codex: 'on', cursor: 'on', pi: 'on' } as const
    await cap.prepareWorkspace(home, forceOn)
    await cap.prepareWorkspace('', forceOn)
    expect(existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false)

    // Sanity: the same capability still prepares a real workspace.
    const cwd = tmpDir('ws-guard')
    await cap.prepareWorkspace(cwd, forceOn)
    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(true)
  })

  test('prepareWorkspace leaves other files in .pi/extensions alone and reclaims a drifted cate-hook.ts', async () => {
    const cap = makeCap()
    const cwd = tmpDir('ws-pi')
    // .pi already exists here, so 'auto' injects pi.
    mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true })
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'user-ext.ts'), '// mine\n')
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'), '// stale or edited\n')

    await cap.prepareWorkspace(cwd)

    expect(readFileSync(path.join(cwd, '.pi', 'extensions', 'user-ext.ts'), 'utf-8')).toBe('// mine\n')
    // Cate owns cate-hook.ts outright — drifted content is rewritten.
    expect(readFileSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'), 'utf-8')).toContain('CATE_HOOK_ENDPOINT')
  })

  test('prepareWorkspace never clobbers unparseable user hook files and skips CLIs with no folder', async () => {
    const capAll = makeCap()
    const cwd = tmpDir('ws2')
    // .claude exists (so 'auto' injects claude) but its settings are broken —
    // the merge leaves an unparseable user file untouched.
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{broken json')
    await capAll.prepareWorkspace(cwd)
    expect(readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8')).toBe('{broken json')

    // No agent folders present → 'auto' writes nothing at all.
    const capNone = makeCap()
    const cwd2 = tmpDir('ws3')
    await capNone.prepareWorkspace(cwd2)
    expect(existsSync(path.join(cwd2, '.claude'))).toBe(false)
    expect(existsSync(path.join(cwd2, '.codex'))).toBe(false)
    expect(existsSync(path.join(cwd2, '.cursor'))).toBe(false)
    expect(existsSync(path.join(cwd2, '.pi'))).toBe(false)
  })

  test('auto injects only agents whose config folder already exists', async () => {
    const cap = makeCap()
    const cwd = tmpDir('ws-auto')
    mkdirSync(path.join(cwd, '.git'))
    mkdirSync(path.join(cwd, '.codex')) // only codex is "in use" here

    await cap.prepareWorkspace(cwd) // no config → all 'auto'

    expect(existsSync(path.join(cwd, '.codex', 'hooks.json'))).toBe(true)
    // The rest have no folder → auto skips them (no litter).
    expect(existsSync(path.join(cwd, '.claude'))).toBe(false)
    expect(existsSync(path.join(cwd, '.cursor'))).toBe(false)
    expect(existsSync(path.join(cwd, '.pi'))).toBe(false)
  })

  test("'on' injects with no pre-existing folder; 'off' strips our entries but keeps the user's", async () => {
    const cap = makeCap()
    const cwd = tmpDir('ws-onoff')
    mkdirSync(path.join(cwd, '.git'))
    // Pre-seed a user permission + a user hook so we can prove merge and strip
    // both preserve user content in this shared file.
    mkdirSync(path.join(cwd, '.claude'))
    writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify(
        { permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-thing' }] }] } },
        null,
        2,
      ) + '\n',
    )

    await cap.prepareWorkspace(cwd, { 'claude-code': 'on' })
    let settings = JSON.parse(readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8')) as {
      permissions: { allow: string[] }
      hooks: Record<string, unknown>
    }
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain('cate-hook') // ours added
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)']) // user field kept
    expect(JSON.stringify(settings.hooks.Stop)).toContain('user-thing') // user hook kept

    await cap.prepareWorkspace(cwd, { 'claude-code': 'off' })
    settings = JSON.parse(readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'))
    expect(JSON.stringify(settings)).not.toContain('cate-hook') // ours stripped
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)']) // user field survives
    expect(JSON.stringify(settings.hooks.Stop)).toContain('user-thing') // user hook survives
  })

  test("'off' deletes pi's owned extension but leaves user extensions", async () => {
    const cap = makeCap()
    const cwd = tmpDir('ws-pi-off')
    mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true })
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'user-ext.ts'), '// mine\n')

    await cap.prepareWorkspace(cwd) // auto: .pi exists → injects pi
    expect(existsSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'))).toBe(true)

    await cap.prepareWorkspace(cwd, { pi: 'off' })
    expect(existsSync(path.join(cwd, '.pi', 'extensions', 'cate-hook.ts'))).toBe(false)
    expect(readFileSync(path.join(cwd, '.pi', 'extensions', 'user-ext.ts'), 'utf-8')).toBe('// mine\n')
  })

  test('opencode: auto gates the plugin file on .opencode, off removes it', async () => {
    const cap = makeCap()
    const rel = path.join('.opencode', 'plugin', 'cate-hook.js')
    const gated = tmpDir('ws-opencode-auto')

    // auto + no .opencode folder → no file (the ambient env var still covers it).
    await cap.prepareWorkspace(gated)
    expect(existsSync(path.join(gated, rel))).toBe(false)

    // 'on' writes it even without the folder; it must land in opencode's scan
    // glob (`{plugin,plugins}/*.{ts,js}`) and carry Cate's marker.
    await cap.prepareWorkspace(gated, { opencode: 'on' })
    expect(readFileSync(path.join(gated, rel), 'utf-8')).toContain(CATE_HOOK_MARKER)

    await cap.prepareWorkspace(gated, { opencode: 'off' })
    expect(existsSync(path.join(gated, rel))).toBe(false)

    // auto + .opencode present → injected, and a user's own plugin is left alone.
    const used = tmpDir('ws-opencode-used')
    mkdirSync(path.join(used, '.opencode', 'plugin'), { recursive: true })
    writeFileSync(path.join(used, '.opencode', 'plugin', 'user.js'), '// mine\n')
    await cap.prepareWorkspace(used)
    expect(existsSync(path.join(used, rel))).toBe(true)
    await cap.prepareWorkspace(used, { opencode: 'off' })
    expect(existsSync(path.join(used, rel))).toBe(false)
    expect(readFileSync(path.join(used, '.opencode', 'plugin', 'user.js'), 'utf-8')).toBe('// mine\n')
  })

  test('inspectWorkspace reports per-agent folder + injected state for the Settings UI', async () => {
    const cap = makeCap()
    const cwd = tmpDir('ws-inspect')
    mkdirSync(path.join(cwd, '.git'))
    mkdirSync(path.join(cwd, '.claude')) // folder present but left un-injected
    mkdirSync(path.join(cwd, '.codex')) // injected below
    await cap.prepareWorkspace(cwd, { codex: 'on', 'claude-code': 'off' })

    const states = await cap.inspectWorkspace(cwd)
    const byId = Object.fromEntries(states.map((s) => [s.agentId, s]))

    expect(byId.codex).toMatchObject({ folderPresent: true, injected: true })
    expect(byId['claude-code']).toMatchObject({ folderPresent: true, injected: false })
    expect(byId.cursor).toMatchObject({ folderPresent: false, injected: false })
    expect(byId.pi).toMatchObject({ folderPresent: false, injected: false })
    // opencode injects a repo file like every other agent.
    expect(byId.opencode).toMatchObject({ folderPresent: false, injected: false })
    // Every agent carries a display name for the UI.
    expect(states.every((s) => s.displayName.length > 0)).toBe(true)
  })

  test('inspectWorkspace touches no files for a home / relative cwd', async () => {
    const cap = makeCap()
    const states = await cap.inspectWorkspace(os.homedir())
    expect(states.length).toBeGreaterThan(0) // still lists agents for the UI
    expect(states.every((s) => !s.folderPresent && !s.injected)).toBe(true)
  })

  test('subscribe/unsubscribe stops delivery; dispose keeps the stable hooks dir', async () => {
    const cap = createAgentHooksCapability({ hooksDir: tmpDir('dispose') })
    const { url, tokenFor, dir } = await cap.endpoint()
    const events: AgentHookEvent[] = []
    const unsub = cap.subscribe((e) => events.push(e))
    const payload = { event: 'agent_end', sessionId: 's-1', sessionFile: '/f', cwd: '/w' }
    await post(url, tokenFor('t'), { agentId: 'pi', terminalId: 't', payload })
    await waitFor(() => events.length === 1)
    unsub()
    await post(url, tokenFor('t'), { agentId: 'pi', terminalId: 't', payload })
    await new Promise((r) => setTimeout(r, 100))
    expect(events.length).toBe(1)

    cap.dispose()
    const env = await cap.envForPty('t2', { PATH: '/bin' })
    expect(env).toEqual({ PATH: '/bin' }) // disposed → plain env
    // The dir survives dispose: repo hook files embed its bridge paths.
    expect(existsSync(dir)).toBe(true)
  })
})

describe('ensureGitExcluded', () => {
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

// The offline half of the interrupt-recovery contract: the live half (that the
// real transcript actually carries these markers on abort) is pinned in
// agentHookContracts.itest.ts. Here we drive the FSM plumbing with a fake
// transcript, no CLI: turn-start arms a tail-watch, and a marker appended to
// the transcript synthesizes the turn-end the CLI never pushed.
describe('agentHooks interrupt recovery', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const CLAUDE_INTERRUPT =
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}\n'
  const CODEX_INTERRUPT = '{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}\n'
  const synthEnds = (events: AgentHookEvent[]): AgentHookEvent[] =>
    events.filter((e) => e.kind === 'turn-end' && (e.raw as { __cateInterruptRecovery?: unknown }).__cateInterruptRecovery)

  function transcriptFile(seed: string): string {
    const dir = tmpDir('transcript')
    const file = path.join(dir, 'transcript.jsonl')
    writeFileSync(file, seed)
    return file
  }

  test('claude: a transcript interrupt marker synthesizes turn-end', async () => {
    const cap = makeCap({ interruptPollMs: 20 })
    const events = collect(cap)
    const { url, tokenFor } = await cap.endpoint()
    const transcript = transcriptFile('{"type":"summary"}\n') // a non-empty baseline
    const sid = '11111111-2222-4333-8444-555555555555'

    // Turn-start arms the watch, baselined at the current transcript size.
    await post(url, tokenFor('t-int'), {
      agentId: 'claude-code',
      terminalId: 't-int',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: '/w', transcript_path: transcript },
    })
    await waitFor(() => events.some((e) => e.kind === 'turn-start'))

    // Ordinary streamed output must NOT trip it — only the marker does.
    appendFileSync(transcript, '{"type":"assistant","message":{"content":[{"type":"text","text":"1\\n2\\n3"}]}}\n')
    await sleep(120)
    expect(synthEnds(events)).toHaveLength(0)

    // The interrupt marker lands → the turn-end the CLI never pushed.
    appendFileSync(transcript, CLAUDE_INTERRUPT)
    await waitFor(() => synthEnds(events).length > 0)
    const end = synthEnds(events)[0]
    expect(end.agentId).toBe('claude-code')
    expect(end.sessionId).toBe(sid) // carried from turn-start for the stamp
    expect(end.cwd).toBe('/w')
    expect(end.transcriptPath).toBe(transcript)
  })

  test('a real hook turn-end disarms the watch — no synthetic double', async () => {
    const cap = makeCap({ interruptPollMs: 20 })
    const events = collect(cap)
    const { url, tokenFor } = await cap.endpoint()
    const transcript = transcriptFile('')
    const sid = '22222222-3333-4444-8555-666666666666'

    await post(url, tokenFor('t-norm'), {
      agentId: 'claude-code',
      terminalId: 't-norm',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: '/w', transcript_path: transcript },
    })
    await waitFor(() => events.some((e) => e.kind === 'turn-start'))
    // The turn ends through its real Stop hook — the watch disarms.
    await post(url, tokenFor('t-norm'), {
      agentId: 'claude-code',
      terminalId: 't-norm',
      payload: { hook_event_name: 'Stop', session_id: sid, cwd: '/w', transcript_path: transcript },
    })
    await waitFor(() => events.some((e) => e.kind === 'turn-end'))

    // A marker written AFTER the turn already ended must not resurrect it.
    appendFileSync(transcript, CLAUDE_INTERRUPT)
    await sleep(120)
    expect(synthEnds(events)).toHaveLength(0)
  })

  test('the baseline ignores an interrupt marker from an earlier turn', async () => {
    const cap = makeCap({ interruptPollMs: 20 })
    const events = collect(cap)
    const { url, tokenFor } = await cap.endpoint()
    // The transcript already carries a PRIOR turn's interrupt marker.
    const transcript = transcriptFile(CLAUDE_INTERRUPT)

    await post(url, tokenFor('t-base'), {
      agentId: 'claude-code',
      terminalId: 't-base',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w', transcript_path: transcript },
    })
    await waitFor(() => events.some((e) => e.kind === 'turn-start'))
    // Only fresh, non-marker output for this turn → no synthetic turn-end.
    appendFileSync(transcript, '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n')
    await sleep(120)
    expect(synthEnds(events)).toHaveLength(0)
  })

  test('codex: a rollout turn_aborted record synthesizes turn-end', async () => {
    const cap = makeCap({ interruptPollMs: 20 })
    const events = collect(cap)
    const { url, tokenFor } = await cap.endpoint()
    const rollout = transcriptFile('{"type":"session_meta"}\n')

    await post(url, tokenFor('t-codex'), {
      agentId: 'codex',
      terminalId: 't-codex',
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'c1', cwd: '/w', transcript_path: rollout },
    })
    await waitFor(() => events.some((e) => e.kind === 'turn-start'))
    appendFileSync(rollout, CODEX_INTERRUPT)
    await waitFor(() => synthEnds(events).length > 0)
    expect(synthEnds(events)[0].agentId).toBe('codex')
  })

  test('a self-healing agent (cursor) arms no watch', async () => {
    const cap = makeCap({ interruptPollMs: 20 })
    const events = collect(cap)
    const { url, tokenFor } = await cap.endpoint()
    const transcript = transcriptFile('')

    await post(url, tokenFor('t-cur'), {
      agentId: 'cursor',
      terminalId: 't-cur',
      payload: { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'x', workspace_roots: ['/w'] },
    })
    await waitFor(() => events.some((e) => e.kind === 'turn-start'))
    // cursor self-heals via a real stop hook, so its transcript is never
    // watched — even a marker in it does nothing.
    appendFileSync(transcript, CLAUDE_INTERRUPT)
    await sleep(120)
    expect(synthEnds(events)).toHaveLength(0)
  })
})
