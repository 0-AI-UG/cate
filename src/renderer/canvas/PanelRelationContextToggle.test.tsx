// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentId } from '../../shared/agents'
import type { WorkspaceState } from '../../shared/types'

const registry = vi.hoisted(() => ({
  panelIdForPty: vi.fn((ptyId: string) => ptyId === 'pty-source' ? 'source' : null),
  ptyIdForPanel: vi.fn((panelId: string) => panelId === 'source' ? 'pty-source' : null),
}))
const openUnsavedTextPanel = vi.hoisted(() => vi.fn(async () => 'preview-panel'))

vi.mock('../lib/terminal/terminalRegistry', () => ({ terminalRegistry: registry }))
vi.mock('../lib/unsavedTextPanel', () => ({ openUnsavedTextPanel }))

import { useAppStore } from '../stores/appStore'
import { useStatusStore } from '../stores/statusStore'
import { PanelRelationContextToggle } from './PanelRelationContextToggle'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const source = { id: 'source', type: 'terminal', title: 'Terminal', isDirty: false } as const
const browser = { id: 'docs', type: 'browser', title: 'Docs', isDirty: false } as const

function workspace(): WorkspaceState {
  return {
    id: 'ws',
    name: 'Workspace',
    color: '#000000',
    rootPath: '/repo',
    panels: { source, docs: browser },
    panelRelations: [{ id: 'relation', fromPanelId: 'source', toPanelId: 'docs', kind: 'use' }],
  } as WorkspaceState
}

function openCli(agentId: AgentId): void {
  const names: Record<AgentId, string> = {
    'claude-code': 'claude',
    codex: 'codex',
    cursor: 'cursor-agent',
    grok: 'grok',
    kiro: 'kiro-cli',
    opencode: 'opencode',
  }
  useStatusStore.setState({
    workspaces: {
      ws: {
        terminals: {
          'pty-source': {
            activity: { type: 'running', processName: names[agentId] },
            agentState: 'running',
            agentName: null,
            agentPresent: false,
            listeningPorts: [],
            cwd: '/repo',
          },
        },
      },
    },
  })
}

describe('PanelRelationContextToggle terminal hook registration', () => {
  let host: HTMLDivElement
  let root: Root
  const setPromptContext = vi.fn(async (_ptyId: string, _context: string | null) => {})
  const showContextMenu = vi.fn<(
    items: import('../../shared/electron-api').NativeContextMenuItem[],
  ) => Promise<string | null>>(async () => null)

  beforeEach(() => {
    setPromptContext.mockClear()
    openUnsavedTextPanel.mockClear()
    showContextMenu.mockReset().mockResolvedValue(null)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agentHooksSetPromptContext: setPromptContext, showContextMenu },
    })
    useAppStore.setState({ selectedWorkspaceId: 'ws', workspaces: [workspace()] })
    useStatusStore.setState({ workspaces: {} })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState({ selectedWorkspaceId: '', workspaces: [] })
    useStatusStore.setState({ workspaces: {} })
  })

  for (const agentId of ['claude-code', 'codex', 'kiro', 'opencode'] as const) {
    it(`registers compiled graph context when ${agentId} opens`, async () => {
      act(() => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
      expect(host.querySelector('button')).toBeNull()

      await act(async () => openCli(agentId))

      expect(host.querySelector('button')?.getAttribute('aria-pressed')).toBe('true')
      expect(setPromptContext).toHaveBeenLastCalledWith(
        'pty-source',
        expect.stringContaining("Use it through Cate browser automation; don't open another browser"),
      )
      const context = setPromptContext.mock.lastCall?.[1] as string
      expect(context.includes('outside the Codex sandbox')).toBe(agentId === 'codex')
    })
  }

  for (const agentId of ['cursor', 'grok'] as const) {
    it(`keeps ${agentId} gated because it has no native context hook`, async () => {
      act(() => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
      await act(async () => openCli(agentId))

      expect(host.querySelector('button')).toBeNull()
      expect(setPromptContext).toHaveBeenLastCalledWith('pty-source', null)
    })
  }

  it('collapses to its icon and reveals the mode label on hover', async () => {
    openCli('codex')
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))

    const button = host.querySelector<HTMLButtonElement>('button')!
    const label = button.querySelector<HTMLSpanElement>('span')!
    expect(label.style.maxWidth).toBe('0px')
    expect(label.style.opacity).toBe('0')

    await act(async () => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(label.style.maxWidth).toBe('180px')
    expect(label.style.opacity).toBe('1')
  })

  it('offers explicit modes and clears registered context when turned off', async () => {
    openCli('codex')
    showContextMenu.mockResolvedValueOnce('off')
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))

    await act(async () => {
      host.querySelector('button')!.click()
    })

    expect(setPromptContext).toHaveBeenLastCalledWith('pty-source', null)
    expect(showContextMenu).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ label: '1 connected panel attached', enabled: false }),
      expect.objectContaining({ id: 'once' }),
      expect.objectContaining({ id: 'always' }),
      expect.objectContaining({ id: 'off' }),
      expect.objectContaining({ id: 'preview', label: 'Preview sent context…' }),
    ]))
  })

  it('opens the exact context in an unsaved text panel from the preview action', async () => {
    openCli('codex')
    showContextMenu.mockResolvedValueOnce('preview')
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))

    await act(async () => { host.querySelector('button')!.click() })

    expect(openUnsavedTextPanel).toHaveBeenCalledWith({
      workspaceId: 'ws',
      sourcePanelId: 'source',
      title: 'Connected panel context.md',
      content: expect.stringContaining('<cate-connected-panels>'),
    })
    const menu = showContextMenu.mock.calls[0][0]
    expect(menu.some((item) => item.label?.includes('must use'))).toBe(false)
  })
})
