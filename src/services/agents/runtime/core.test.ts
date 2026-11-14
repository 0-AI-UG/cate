import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { PanelRecord } from '@workspace/document/contract'
import { createAgentsCore, type AgentsCoreDeps, type AgentTerminals } from './core'
import { createAgentChangesStore } from './changes/store'

it('keeps the latest source title after rename, close and restart, including conditional reads', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cate-source-titles-'))
  const store = createAgentChangesStore(path.join(directory, 'changes'), () => 'Original title')
  store.registerTerminal('pty', { cwd: '/repo', panelId: 'source' })
  await store.ingestHook('pty', 'codex', null, { sessionId: 's', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, output: null, callId: 'edit' })
  let panels: PanelRecord[] = [{ id: 'source', type: 'terminal', title: 'Original title', fields: {} }]
  const listeners = new Set<() => void>()
  const terminals: AgentTerminals = {
    state: () => null, panelIds: () => [], onChange: () => () => {},
    send: async () => ({ ok: true }), interrupt: async () => ({ ok: true }),
    conversation: async () => null, conversationStamp: async () => null,
    onStep: () => () => {}, onConversationReset: () => () => {}, dispose() {},
  }
  const deps: AgentsCoreDeps = {
    root: '/repo', agentsDir: directory,
    trust: { isTrusted: () => true, requireTrusted() {} },
    settings: { agentHookInjection: () => ({}), panelRelationsEnabled: () => true, usagePriceOverrides: () => ({}) },
    document: {
      panel: (id) => panels.find((panel) => panel.id === id), panels: () => panels, relations: () => [],
      worktreePath: () => undefined, setRelationContextMode() {}, setTitleFromAgent() {},
      onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    relationRole: () => ({ execution: true }), resolveCheckout: async (cwd) => cwd ?? '/repo',
    snapshot: async () => ({ nameByPid: new Map(), childrenByPid: new Map() }), notify() {},
  }
  let core = createAgentsCore(deps, () => terminals)
  try {
    const first = await core.changes('/repo')
    expect(first.records?.[0].panelTitles).toEqual({ source: 'Original title' })
    expect(core.cachedChanges('/repo')?.records?.[0].panelTitles).toEqual({ source: 'Original title' })
    expect((await core.changes('/repo', first.revision)).records).toBeUndefined()
    panels = [{ ...panels[0], title: 'Fix checkout races' }]
    for (const listener of listeners) listener()
    expect(core.cachedChanges('/repo')?.records?.[0].panelTitles).toEqual({ source: 'Fix checkout races' })
    const renamed = await core.changes('/repo', first.revision)
    expect(renamed.records?.[0].panelTitles).toEqual({ source: 'Fix checkout races' })
    panels = []
    for (const listener of listeners) listener()
    core.dispose()
    core = createAgentsCore(deps, () => terminals)
    expect((await core.changes('/repo')).records?.[0].panelTitles).toEqual({ source: 'Fix checkout races' })
  } finally { core.dispose(); rmSync(directory, { recursive: true, force: true }) }
})
