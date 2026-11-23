import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import { installClientUi } from '@kernel/interaction'
import { AGENTS, type AgentSetupSnapshot, type AgentAvailability } from '@services/agents/contract'
import { AgentSpawnFlyout } from './AgentSpawnFlyout'
import { AgentSetupSettings } from './AgentSetupSettings'
import { workspaceSettingsTable } from '@panels/settings'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { fakeStream } from '@services/agents/client/testing'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AI & Agents settings', () => {
  let host: HTMLDivElement
  let root: Root
  let stop = () => {}
  const openExternal = vi.fn()
  const setupInspect = vi.fn()
  const inspectHooks = vi.fn()
  const setSetting = vi.fn(async ({ key, value }) => {
    settingsStream.emit({ kind: 'change', rev: ++settingsRevision, change: { [key]: value } })
    publish({ ...serverSnapshot, agents: serverSnapshot.agents.map((agent) => ({ ...agent, hooksReady: value[agent.agentId] === 'on' })) })
  })
  let availabilityStream: ReturnType<typeof fakeStream<ChannelEvent<AgentAvailability, AgentAvailability>>>
  let serverSnapshot: AgentSetupSnapshot
  let revision = 0
  const publish = (snapshot: AgentSetupSnapshot) => {
    serverSnapshot = snapshot
    const state: AgentAvailability = { snapshot, types: snapshot.agents.map((agent) => ({ agentId: agent.agentId, displayName: agent.displayName, ready: agent.installation.status === 'installed' && agent.hooksReady !== false && agent.authentication.status !== 'signed-out' })), refreshing: false, error: null }
    if (!revision) availabilityStream.emit({ kind: 'snapshot', rev: revision++, snapshot: state })
    else availabilityStream.emit({ kind: 'change', rev: revision++, change: state })
  }
  const inspect = async () => {
    try { publish(await setupInspect()) }
    catch { availabilityStream.emit({ kind: 'snapshot', rev: revision++, snapshot: { snapshot: null, types: [], refreshing: false, error: 'Could not inspect agents on this runtime. Try refreshing.' } }) }
  }
  let settingsRevision = 1
  let settingsStream: ReturnType<typeof fakeStream>

  const settingsSubscribe = vi.fn(() => settingsStream.sub)
  const setupBegin = vi.fn()
  const setupCancel = vi.fn()
  const setupOperation = vi.fn()

  const snapshot = (): AgentSetupSnapshot => ({
    host: { name: 'Remote build machine', platform: 'linux', arch: 'x64' },
    agents: AGENTS.map((agent) => ({
      agentId: agent.id,
      displayName: agent.displayName,
      downloadUrl: `https://example.com/download/${agent.id}`,
      installation: { status: 'installed', version: '1.2.3' },
      authentication: { status: 'signed-in', email: 'developer@example.com', plan: 'Pro' },
      canLogin: true,
      canInstall: true,
    })),
  })

  async function render(workspaceId: string | null = 'ws', onOpenSetupTerminal?: (panelId: string) => Promise<boolean>) {
    await act(async () => { root.render(<AgentSetupSettings workspaceId={workspaceId} onOpenSetupTerminal={onOpenSetupTerminal} />) })
    if (workspaceId) await act(async () => { await inspect(); settingsStream.emit({ kind: 'snapshot', rev: 1, snapshot: { ...workspaceSettingsTable.defaults } }) })
  }

  const row = (id: string) => host.querySelector<HTMLElement>(`[data-agent-setup-id="${id}"]`)!
  const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text || node.getAttribute('aria-label') === text)!

  const expand = async (id: string) => { await act(async () => { row(id).querySelector<HTMLButtonElement>('button[aria-expanded]')!.click() }) }

  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    setSetting.mockImplementation(async ({ key, value }) => {
      settingsStream.emit({ kind: 'change', rev: ++settingsRevision, change: { [key]: value } })
      if (key === 'agentHookInjection') publish({ ...serverSnapshot, agents: serverSnapshot.agents.map((agent) => ({ ...agent, hooksReady: value[agent.agentId] === 'on' })) })
    })
    setupInspect.mockResolvedValue(snapshot())
    inspectHooks.mockResolvedValue([])
    settingsStream = fakeStream()
    availabilityStream = fakeStream()
    revision = 0
    settingsRevision = 1
    setupCancel.mockResolvedValue({ ok: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const runtime = { settings: { set: setSetting, subscribe: settingsSubscribe }, agents: { inspectHooks, availability: () => availabilityStream.sub, setupInspect: inspect,
      setupBegin: async (input: unknown) => { const operation = await setupBegin(input); publish({ ...serverSnapshot, operations: [operation] }); return operation },
      setupCancel: async (input: { operationId: string }) => { const result = await setupCancel(input); publish({ ...serverSnapshot, operations: serverSnapshot.operations?.map((op) => op.id === input.operationId ? { ...op, status: 'cancelled' } : op) }); return result }, setupOperation } }
    stop = setRuntimeResolver((id) => id === 'ws' ? runtime as never : null)
    installClientUi({ openExternal } as never)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    stop()
    vi.useRealTimers()
  })

  it('waits for a selected workspace’s runtime instead of asking to open a workspace', async () => {
    await act(async () => root.render(<AgentSetupSettings workspaceId="connecting" />))
    expect(host.textContent).toContain('Loading agents')
    expect(host.textContent).not.toContain('Open a workspace')
  })

  it('requires a workspace rather than configuring the client machine accidentally', async () => {
    await render(null)
    expect(host.textContent).toContain('Open a workspace')
    expect(setupInspect).not.toHaveBeenCalled()
  })

  it('shows all seven agents, the actual host, version and safe native account identity', async () => {
    await render()
    expect(host.querySelectorAll('[data-agent-setup-id]')).toHaveLength(7)
    expect(host.textContent).not.toContain('Remote build machine')
    expect(row('codex').textContent).toContain('developer@example.com · Pro')
    expect(row('codex').textContent).not.toContain('Version')
    await expand('codex')
    expect(row('codex').textContent).toContain('Version 1.2.3')
    await expand('claude-code')
    expect(row('codex').querySelector('[role="region"]')).toBeNull()
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(1)
    await expand('codex')
    expect(row('codex').querySelector('[aria-label="Codex integration"]')).not.toBeNull()
  })

  it('distinguishes an unreadable identity from signed out and keeps downloads available', async () => {
    const state = snapshot()
    state.agents[0].authentication = { status: 'unknown', detail: 'The CLI does not expose account identity.' }
    state.agents[1].installation = { status: 'missing' }
    setupInspect.mockResolvedValue(state)
    await render()
    expect(row('claude-code').textContent).toContain('Account unavailable')
    expect(row('claude-code').textContent).not.toContain('Not signed in')
    await expand('codex')
    expect(button(row('codex'), 'Install')).toBeTruthy()
    await act(async () => { button(row('codex'), 'Codex download').click() })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/download/codex')
  })

  it.each(AGENTS)('$id starts native login and offers cancellation without collecting the password', async ({ id }) => {
    setupBegin.mockResolvedValue({ id: 'login-1', agentId: id, action: 'login', status: 'running', panelId: 'login-terminal', message: 'Finish sign-in in the terminal.', startedAt: new Date().toISOString() })
    await render()
    await expand(id)
    await act(async () => { button(row(id), 'Switch account').click() })
    expect(setupBegin).toHaveBeenCalledWith({ agentId: id, action: 'login' })
    expect(row(id).textContent).toContain('Signing in…')
    expect(row(id).querySelector('input[type="password"]')).toBeNull()
    await act(async () => { button(row(id), 'Cancel').click() })
    expect(setupCancel).toHaveBeenCalledWith({ operationId: 'login-1' })
    expect(button(row(id), 'Cancel')).toBeUndefined()
  })




  it('recovers running setup progress after reopening settings', async () => {
    const state = snapshot()
    state.operations = [{ id: 'existing-login', agentId: 'codex', action: 'login', status: 'running', message: 'Complete the existing sign-in terminal.', startedAt: new Date().toISOString() }]
    setupInspect.mockResolvedValue(state)
    await render()
    expect(row('codex').textContent).toContain('Signing in…')
    await act(async () => { button(row('codex'), 'Cancel').click() })
    expect(setupCancel).toHaveBeenCalledWith({ operationId: 'existing-login' })
    expect(setupBegin).not.toHaveBeenCalled()
  })

  it.each(['running', 'failed'] as const)('opens the native setup terminal for a %s operation', async (status) => {
    const state = snapshot()
    state.operations = [{ id: 'native-login', agentId: 'codex', action: 'login', status, panelId: 'login-terminal', startedAt: new Date().toISOString() }]
    setupInspect.mockResolvedValue(state)
    const open = vi.fn().mockResolvedValue(true)
    await render('ws', open)
    await act(async () => { button(row('codex'), 'Open setup terminal').click() })
    expect(open).toHaveBeenCalledWith('login-terminal')
  })

  it('explains when the setup terminal was closed before navigation', async () => {
    const state = snapshot()
    state.operations = [{ id: 'native-login', agentId: 'codex', action: 'login', status: 'failed', panelId: 'closed-terminal', startedAt: new Date().toISOString() }]
    setupInspect.mockResolvedValue(state)
    await render('ws', async () => false)
    await act(async () => { button(row('codex'), 'Open setup terminal').click() })
    expect(row('codex').textContent).toContain('The setup terminal is no longer open.')
  })



  it('enables an installed native agent in this workspace before launch', async () => {
    const state = snapshot()
    const info = state.agents.find((agent) => agent.agentId === 'codex')!
    info.hooksReady = false
    setupInspect.mockResolvedValue(state)
    await render()
    await expand('codex')
    await act(async () => { const integration = row('codex').querySelector<HTMLSelectElement>('[aria-label="Codex integration"]')!; integration.value = 'on'; integration.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(setSetting).toHaveBeenCalledWith({ key: 'agentHookInjection', value: { codex: 'on' } })
    expect(row('codex').textContent).not.toContain('Integration off')
  })


  it('reports a failed inspection', async () => {
    setupInspect.mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(host.textContent).toContain('Could not inspect agents')
  })
  it('updates settings and an open launcher from the same server publication', async () => {
    await act(async () => {
      root.render(<><AgentSetupSettings workspaceId="ws" /><AgentSpawnFlyout workspaceId="ws" side="up" onPick={() => {}} onShown={() => {}} /></>)
    })
    await act(async () => {
      await inspect()
      settingsStream.emit({ kind: 'snapshot', rev: 1, snapshot: { ...workspaceSettingsTable.defaults } })
    })
    expect(host.querySelector('[aria-label="New Codex"]')).not.toBeNull()
    const next = snapshot()
    next.agents.find((agent) => agent.agentId === 'codex')!.installation = { status: 'missing' }
    act(() => publish(next))
    expect(row('codex').textContent).toContain('Not installed')
    expect(host.querySelector('[aria-label="New Codex"]')).toBeNull()
    expect(setupOperation).not.toHaveBeenCalled()
  })

})
