// @vitest-environment jsdom
//
// The canvas subagent's tool dispatch: the short-id trick (agent sees/echoes an
// 8-char prefix, we recover the real panel id), the panel->node mapping used by
// move/resize, panel creation routing by type, and the orchestrator's `canvas`
// delegation. Every sibling module is mocked so the routing is exercised in
// isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared fakes live in vi.hoisted so the (hoisted) vi.mock factories below can
// reference them without a temporal-dead-zone error.
const h = vi.hoisted(() => {
  const workspace = {
    id: 'ws1',
    panels: {
      'term-aaaaaaaa-1111': { id: 'term-aaaaaaaa-1111', type: 'terminal', title: 'Terminal 1' },
      'edit-bbbbbbbb-2222': { id: 'edit-bbbbbbbb-2222', type: 'editor', title: 'main.ts' },
    } as Record<string, { id: string; type: string; title: string }>,
  }
  const nodeForPanel = vi.fn((panelId: string) => (panelId ? `node-for-${panelId}` : null))
  return {
    createTerminal: vi.fn(() => 'panel-terminal-1234567890'),
    createBrowser: vi.fn(() => 'panel-browser-1234567890'),
    createEditor: vi.fn(() => 'panel-editor-1234567890'),
    createDocument: vi.fn(() => 'panel-document-1234567890'),
    createCanvas: vi.fn(() => 'panel-canvas-1234567890'),
    createCateAgent: vi.fn(() => 'panel-agent-1234567890'),
    workspace,
    nodeForPanel,
    moveNode: vi.fn(),
    resizeNode: vi.fn(),
    closeCanvasPanel: vi.fn(),
    readTerminalState: vi.fn(async () => ({ output: '  $ npm test\nall good  ', isRunning: false, lastExitCode: 0, agentState: null })),
    runCanvasAgentToCompletion: vi.fn(async () => true),
  }
})
const { createTerminal, createBrowser, nodeForPanel, moveNode, resizeNode, closeCanvasPanel, runCanvasAgentToCompletion } = h

vi.mock('../../renderer/stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: [h.workspace], createTerminal: h.createTerminal, createBrowser: h.createBrowser, createEditor: h.createEditor, createDocument: h.createDocument, createCanvas: h.createCanvas, createCateAgent: h.createCateAgent }) },
  pickWorktreeColor: () => 'rgb(0,0,0)',
}))
vi.mock('../../renderer/lib/workspace/canvasAccess', () => ({
  getAgentCanvasStore: () => ({
    getState: () => ({
      nodes: {
        n1: {
          dockLayout: { type: 'tabs', id: 'stack-term', panelIds: ['term-aaaaaaaa-1111'], activeIndex: 0 },
          origin: { x: 10.4, y: 20.6 }, size: { width: 300.2, height: 200.9 },
        },
        n2: {
          dockLayout: { type: 'tabs', id: 'stack-edit', panelIds: ['edit-bbbbbbbb-2222'], activeIndex: 0 },
          origin: { x: 400, y: 0 }, size: { width: 500, height: 400 },
        },
      },
      nodeForPanel: h.nodeForPanel,
      moveNode: h.moveNode,
      resizeNode: h.resizeNode,
    }),
  }),
}))
vi.mock('./canvasAgentLauncher', () => ({ runCanvasAgentToCompletion: h.runCanvasAgentToCompletion }))
vi.mock('./cateAgentTerminals', () => ({
  shortId: (id: string) => id.slice(0, 8),
  closeCanvasPanel: h.closeCanvasPanel,
  readTerminalState: h.readTerminalState,
  ptyFor: () => undefined,
  terminalBusy: () => false,
}))
// Modules imported by cateAgentTools that the canvas cases never touch — stubbed
// so the import graph stays trivial and deterministic.
vi.mock('../../renderer/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('../../renderer/stores/chatsStore', () => ({
  useChatsStore: {
    getState: () => ({
      getChats: () => [],
      getChat: () => ({ id: 't1', title: 'x', messages: [], createdAt: 0, updatedAt: 0 }),
      getRun: () => undefined,
      patchRun: vi.fn(),
      appendMessage: vi.fn(),
      patchMessage: vi.fn(),
    }),
  },
}))
vi.mock('../../renderer/stores/gitStatusStore', () => ({ gitStatusStore: { refresh: vi.fn() } }))
vi.mock('./cateAgentStore', () => ({ useCateAgentStore: { getState: () => ({ get: () => ({ inputOpen: true }), setUnseen: vi.fn(), appendFeed: vi.fn() }) } }))
vi.mock('../../renderer/stores/canvas/helpers', () => ({ generateId: () => 'id' }))
vi.mock('./codingAgentLauncher', () => ({ runDriverToCompletion: vi.fn(), openDriverTerminal: vi.fn(), armBackgroundSend: vi.fn() }))
vi.mock('./cateAgentWorktrees', () => ({ worktreeMetaFor: vi.fn(), teardownWorktree: vi.fn() }))
vi.mock('../../renderer/lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn() } }))

import { runCateAgentTool } from './cateAgentTools'
import type { CateAgentContext } from './cateAgentTypes'

const canvasCtx: CateAgentContext = { panelId: 'cate-agent-canvas:x', workspaceId: 'ws1', rootPath: '/repo', role: 'canvas', canvasPanelId: 'canvas-1' }
const orchestratorCtx: CateAgentContext = { panelId: 'cate-agent-orchestrator:t', workspaceId: 'ws1', rootPath: '/repo', role: 'orchestrator', chatId: 't1', canvasPanelId: 'canvas-1' }

beforeEach(() => vi.clearAllMocks())

describe('canvas subagent tool dispatch', () => {
  it('list_canvas returns every panel with a short id, rounded geometry, and a terminal preview', async () => {
    const out = JSON.parse(await runCateAgentTool(canvasCtx, 'list_canvas', {}))
    expect(out.panels).toHaveLength(2)
    const term = out.panels.find((p: { type: string }) => p.type === 'terminal')
    expect(term.id).toBe('term-aaa'.slice(0, 8)) // shortId = first 8 chars of panelId
    expect(term.id).toHaveLength(8)
    expect(term).toMatchObject({ type: 'terminal', title: 'Terminal 1', x: 10, y: 21, w: 300, h: 201 })
    expect(term.preview).toContain('all good')
    const editor = out.panels.find((p: { type: string }) => p.type === 'editor')
    expect(editor.preview).toBeUndefined() // only terminals get a preview
  })

  it('move_panel recovers the panel from its short id and moves the mapped node', async () => {
    const out = JSON.parse(await runCateAgentTool(canvasCtx, 'move_panel', { id: 'term-aaa', x: 99, y: 77 }))
    expect(out).toEqual({ ok: true })
    expect(nodeForPanel).toHaveBeenCalledWith('term-aaaaaaaa-1111')
    expect(moveNode).toHaveBeenCalledWith('node-for-term-aaaaaaaa-1111', { x: 99, y: 77 })
  })

  it('resize_panel maps w/h onto the node size', async () => {
    const out = JSON.parse(await runCateAgentTool(canvasCtx, 'resize_panel', { id: 'edit-bbb', w: 640, h: 480 }))
    expect(out).toEqual({ ok: true })
    expect(resizeNode).toHaveBeenCalledWith('node-for-edit-bbbbbbbb-2222', { width: 640, height: 480 })
  })

  it('close_panel resolves the short id and closes the real panel', async () => {
    const out = JSON.parse(await runCateAgentTool(canvasCtx, 'close_panel', { id: 'edit-bbb' }))
    expect(out).toEqual({ ok: true })
    expect(closeCanvasPanel).toHaveBeenCalledWith('ws1', 'edit-bbbbbbbb-2222')
  })

  it('create_panel routes by type and returns the new panel short id', async () => {
    const browser = JSON.parse(await runCateAgentTool(canvasCtx, 'create_panel', { type: 'browser', url: 'https://x.dev', x: 5, y: 6 }))
    // Pinned to the job's canvas via placement.canvasPanelId.
    expect(createBrowser).toHaveBeenCalledWith('ws1', 'https://x.dev', { x: 5, y: 6 }, { target: 'canvas', focus: false, canvasPanelId: 'canvas-1' })
    expect(browser).toEqual({ ok: true, id: 'panel-br' })

    await runCateAgentTool(canvasCtx, 'create_panel', { type: 'terminal', cwd: '/w' })
    // No x/y -> auto-placed (undefined position); cwd + pinned canvas threaded through.
    expect(createTerminal).toHaveBeenCalledWith('ws1', undefined, undefined, { target: 'canvas', focus: false, canvasPanelId: 'canvas-1' }, '/w')
  })

  it('unknown panel type is rejected', async () => {
    const out = JSON.parse(await runCateAgentTool(canvasCtx, 'create_panel', { type: 'bogus' }))
    expect(out.ok).toBe(false)
  })

  it('orchestrator canvas tool runs the subagent and returns the resulting snapshot', async () => {
    const out = JSON.parse(await runCateAgentTool(orchestratorCtx, 'canvas', { request: 'tidy up' }))
    expect(runCanvasAgentToCompletion).toHaveBeenCalledWith({ wsId: 'ws1', rootPath: '/repo', request: 'tidy up', canvasPanelId: 'canvas-1' })
    expect(out.ok).toBe(true)
    expect(out.canvas.panels).toHaveLength(2)
  })

  it('canvas tool requires a request', async () => {
    const out = JSON.parse(await runCateAgentTool(orchestratorCtx, 'canvas', {}))
    expect(out.ok).toBe(false)
    expect(runCanvasAgentToCompletion).not.toHaveBeenCalled()
  })
})
