import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAgentHooksCapability } from './agentHooks'
import type { AgentTitleResolvers } from './agentTitles/types'
import type { AgentHookEvent } from '../../shared/agentHooks'

it('closing hooked terminals cancels their pending title lookups and late events', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cate-hook-lifetime-'))
  const resolveTitle = vi.fn(async () => 'Synthetic session')
  const hooks = createAgentHooksCapability({
    hooksDir: directory,
    titleRetryDelaysMs: [200],
    titleResolvers: new Proxy({}, { get: () => resolveTitle }) as AgentTitleResolvers,
  })
  const events: AgentHookEvent[] = []
  hooks.subscribe(event => events.push(event))
  try {
    const endpoint = await hooks.endpoint()
    for (let i = 0; i < 20; i++) {
      const terminalId = `closed-${i}`
      const response = await fetch(`${endpoint.url}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.tokenFor(terminalId)}` },
        body: JSON.stringify({ agentId: 'codex', terminalId, payload: {
          hook_event_name: 'SessionStart', session_id: `session-${i}`, cwd: directory,
        } }),
      })
      expect(response.status).toBe(204)
      hooks.forgetTerminal(terminalId)
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(events.filter(event => event.kind === 'session-start')).toHaveLength(20)
    expect(resolveTitle, 'closed terminals must not keep reading CLI metadata').not.toHaveBeenCalled()
    expect(events.filter(event => event.kind === 'session-title')).toHaveLength(0)
  } finally {
    hooks.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
