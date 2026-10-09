// The title a sidebar panel row shows for a terminal hosting each agent CLI:
// the agent's name in place of a fallback title, the session title once the
// CLI names it, the terminal title again once the CLI exits.

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PanelRecord } from '@workspace/document/contract'
import { AGENTS } from '@services/agents/contract'
import { agentLogo, type AgentPanelInfo } from '../../services/agents'
import { WorkspacePanelRow } from './WorkspaceRow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const record = (title: string): PanelRecord => ({ id: 't1', type: 'terminal', title, fields: {} })
const rowText = (title: string, agent?: AgentPanelInfo) => {
  act(() => root.render(<WorkspacePanelRow record={record(title)} depth={0} agent={agent} onClick={() => {}} />))
  return container.textContent ?? ''
}

describe('sidebar row titles for every agent CLI', () => {
  for (const agent of AGENTS) {
    it(agent.displayName, () => {
      const open: AgentPanelInfo = { status: 'waitingForInput', runner: 'terminal', name: agent.displayName, logo: agentLogo(agent.id) }
      const exited: AgentPanelInfo = { status: 'notRunning', runner: 'terminal', name: null, logo: null }

      expect(rowText('Terminal 1')).toContain('Terminal 1')
      expect(rowText('Terminal 1', open)).toContain(agent.displayName)
      expect(rowText('Terminal 1', open)).not.toContain('Terminal 1')
      expect(rowText('Fix the login flow', open)).toContain('Fix the login flow')
      expect(rowText('Terminal 1', exited)).toContain('Terminal 1')
    })
  }
})
