import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createAgentHooksCapability } from './agentHooks'
import { HERMES_PLUGIN_MANIFEST, HERMES_PLUGIN_SOURCE } from './hermesIntegration'

describe('managed Hermes plugin asset', () => {
  it.skipIf(spawnSync('python3', ['--version']).status !== 0)('forwards approval surface without leaking other hook inputs', () => {
    const payloads = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
ns = {}
exec(sys.stdin.read(), ns)
payloads = []
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return b""
class Opener:
    def open(self, request, **kwargs):
        payloads.append(json.loads(request.data)["payload"])
        return Response()
ns["_connection"] = lambda: ("http://127.0.0.1:1", "test-token", "test-terminal")
ns["_OPENER"] = Opener()
for surface in ["smart", "cli", "transport:custom"]:
    for name in ["pre_approval_request", "post_approval_response"]:
        ns["_report"](name, "default", session_id="test-session", platform="cli", surface=surface,
                      command="private command", messages=["private conversation"])
ns["_report"]("pre_llm_call", "default", platform="cli", surface="smart")
print(json.dumps(payloads))
`], { input: HERMES_PLUGIN_SOURCE, encoding: 'utf8' })) as Array<Record<string, unknown>>
    expect(payloads.map(p => p.surface)).toEqual(['smart', 'smart', 'cli', 'cli', 'transport:custom', 'transport:custom', undefined])
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty('command')
      expect(payload).not.toHaveProperty('messages')
    }
  })

  it('declares every registered hook and returns Cate context from pre_llm_call', () => {
    const hooks = [
      'on_session_start', 'on_session_reset', 'pre_llm_call', 'on_session_end',
      'on_session_finalize', 'pre_approval_request', 'post_approval_response', 'post_tool_call',
    ]
    for (const hook of hooks) {
      expect(HERMES_PLUGIN_MANIFEST).toContain(`  - ${hook}`)
      expect(HERMES_PLUGIN_SOURCE).toContain(`"${hook}"`)
    }
    expect(HERMES_PLUGIN_SOURCE).toContain('return {"context": output}')
    expect(HERMES_PLUGIN_SOURCE).toContain('endpoint + "/hook"')
    expect(HERMES_PLUGIN_SOURCE).toContain('ProxyHandler({})')
    expect(HERMES_PLUGIN_SOURCE).toContain('time.monotonic_ns()')
    expect(HERMES_PLUGIN_SOURCE).toContain('CATE_HERMES_HOOKS')
    expect(HERMES_PLUGIN_SOURCE).toContain('if key in allowed')
    expect(HERMES_PLUGIN_SOURCE).not.toContain('payload = dict(kwargs)')
  })
})

const hasPython = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()

describe.skipIf(!hasPython)('managed Hermes plugin load', () => {
  it('announces the open agent to Cate when Hermes loads it, before any prompt', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cate-hermes-plugin-'))
    const posts: Array<{ terminalId: string; agentId: string; pid?: number; sourceStartedAt?: string }> = []
    const hooks = createAgentHooksCapability({ hooksDir: path.join(dir, 'hooks'), onPost: (post) => { posts.push(post) } })
    const events: unknown[] = []
    const unsubscribe = hooks.subscribe((event) => events.push(event))
    try {
      mkdirSync(path.join(dir, 'cate_agent_state'))
      writeFileSync(path.join(dir, 'cate_agent_state', '__init__.py'), HERMES_PLUGIN_SOURCE)
      const env = await hooks.envForPty('pty-hermes', { PATH: process.env.PATH ?? '' }, { hermes: 'on' })
      // What Hermes does at launch: import the plugin and call register(ctx).
      const script = [
        'import os, sys',
        `sys.path.insert(0, ${JSON.stringify(dir)})`,
        'import cate_agent_state',
        'class Ctx:',
        '    profile_name = "default"',
        '    def register_hook(self, name, callback): pass',
        'cate_agent_state.register(Ctx())',
        'print(os.getpid())',
      ].join('\n')
      // Async: the hook endpoint lives in this process and must answer the post.
      const pid = Number((await promisify(execFile)('python3', ['-c', script], { env, encoding: 'utf8' })).stdout.trim())
      expect(posts).toEqual([{ terminalId: 'pty-hermes', agentId: 'hermes', pid, sourceStartedAt: expect.any(String) }])
      expect(events).toEqual([]) // presence only; no turn or session state
    } finally {
      unsubscribe()
      hooks.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
