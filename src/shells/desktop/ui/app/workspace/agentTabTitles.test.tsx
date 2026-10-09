// The title a dock tab shows for a terminal hosting each agent CLI: the
// agent's name in place of a fallback title until the CLI names its session,
// then the session title. Dock tabs, canvas nodes and the sidebar all draw
// panel titles; the dock tab is the one shared by the dock and the canvas.

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { AGENTS, type AgentPanelStates, type AgentPanelStatesChange, type PanelAgentState } from '@services/agents/contract'
import { fakeStream } from '@services/agents/client/testing'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelDefinitions } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { DockView, registerTabDecorations } from '../../client/layout/dock'
import { useAgentTabDecorations } from '../../services/agents'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { windowId: MAIN_WINDOW }
let ws: TestWorkspace
let container: HTMLDivElement
let root: Root
let stream: ReturnType<typeof fakeStream<ChannelEvent<AgentPanelStates, AgentPanelStatesChange>>>
const stops: Array<() => void> = []

beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: [] }))
  ws = attachTestWorkspace('w', buildDocument([add('t1', { to: 'stack', dock: main, stackId: 's1' })]))
  stream = fakeStream()
  const runtime = { agents: { panels: () => stream.sub } }
  stops.push(setRuntimeResolver((id) => (id === 'w' ? (runtime as never) : null)))
  stops.push(registerTabDecorations(useAgentTabDecorations))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  for (const stop of stops.splice(0)) stop()
  ws.detach()
  installClientIdentity(null)
})

const renderDock = () => act(() => { root.render(<DockView workspaceId="w" dock={main} renderPanel={(id) => <div>{id}</div>} />) })
const tabText = () => container.querySelector<HTMLElement>('[data-tab-panel-id="t1"]')!.textContent ?? ''
const setTitle = (title: string) => act(() => ws.remote({ kind: 'updatePanel', id: 't1', patch: { title } }))
const agentState = (agent: (typeof AGENTS)[number], patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 't1',
  agentId: agent.id,
  agentName: agent.displayName,
  label: agent.displayName,
  takesOverPanel: true,
  contextPolicy: null,
  status: 'waitingForInput',
  present: true,
  canReceivePrompt: true,
  session: null,
  ...patch,
})
const emitState = (state: PanelAgentState) =>
  act(() => stream.emit({ kind: 'snapshot', rev: 1, snapshot: { t1: state } }))

describe('dock tab titles for every agent CLI', () => {
  for (const agent of AGENTS) {
    describe(agent.displayName, () => {
      it('shows the agent name in place of a fallback terminal title', () => {
        setTitle('Terminal 1')
        renderDock()
        expect(tabText()).toContain('Terminal 1')

        emitState(agentState(agent))
        expect(tabText()).toContain(agent.displayName)
        expect(tabText()).not.toContain('Terminal 1')
      })

      it('shows the session title once the CLI names the session', () => {
        setTitle('Terminal 1')
        renderDock()
        emitState(agentState(agent))

        setTitle(`${agent.displayName} session title`)
        expect(tabText()).toContain(`${agent.displayName} session title`)
      })

      it('goes back to the terminal title once the CLI exits', () => {
        setTitle('Terminal 1')
        renderDock()
        emitState(agentState(agent))

        emitState(agentState(agent, { present: false, agentName: null, label: null, status: 'notRunning' }))
        expect(tabText()).toContain('Terminal 1')
        expect(tabText()).not.toContain(agent.displayName)
      })
    })
  }
})
