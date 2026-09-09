import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ createEditor: vi.fn(), createDocument: vi.fn(), workspace: { id: 'ws', rootPath: '/repo', panels: { review: { reviewState: { repoPath: '/repo', spec: { kind: 'uncommitted' }, display: {}, notes: [{ path: 'gone.ts', side: 'file', status: 'open' }] } as any } } } }))
vi.mock('../stores/appStore', () => ({ useAppStore: Object.assign((selector: any) => selector({ workspaces: [h.workspace] }), { getState: () => ({ createEditor: h.createEditor, createDocument: h.createDocument, getWorkspace: () => h.workspace, setPanelReviewState: (_w: string, _p: string, next: any) => { h.workspace.panels.review.reviewState = next } }) }) }))
vi.mock('../stores/gitStatusStore', () => ({ useGitStatusSnapshot: () => ({ revision: 0 }), gitStatusStore: {} }))
vi.mock('../stores/useWorktrees', () => ({ useWorktrees: () => [] }))
vi.mock('../lib/review/reviewAgent', () => ({}))
vi.mock('../lib/agent/codingAgentDriver', () => ({}))
vi.mock('../lib/workspace/canvasAccess', () => ({ placementForPanel: () => ({ target: 'dock', zone: 'right', stackId: 'review-stack' }) }))
import GitReviewPanel from './GitReviewPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
it('does not overwrite Agent changes when an unmounted Git comparison finishes', async () => {
  let resolve!: (value: any) => void
  window.electronAPI = { gitCompare: () => new Promise((done) => { resolve = done }), gitBranchList: async () => ({ branches: [] }), gitLog: async () => [] } as any
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<GitReviewPanel workspaceId="ws" panelId="review" />))
    h.workspace.panels.review.reviewState = { ...h.workspace.panels.review.reviewState, agentChanges: {} }
    await act(async () => root.render(null))
    await act(async () => resolve({ files: [], additions: 0, deletions: 0 }))
    expect(h.workspace.panels.review.reviewState.agentChanges).toEqual({})
  } finally { act(() => root.unmount()) }
})

it.each([['a.png', 'image'], ['a.pdf', 'pdf'], ['a.docx', 'docx']])('routes review file %s to its document surface', async (path, type) => {
  h.createEditor.mockClear(); h.createDocument.mockClear()
  h.workspace.panels.review.reviewState = { repoPath: '/repo', spec: { kind: 'uncommitted' }, display: {}, notes: [] }
  window.electronAPI = { gitCompare: async () => ({ files: [{ path, status: 'modified', additions: 0, deletions: 0 }], additions: 0, deletions: 0 }), gitBranchList: async () => ({ branches: [] }), gitLog: async () => [] } as any
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<GitReviewPanel workspaceId="ws" panelId="review" />))
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open file"]')!
    expect(open).not.toBeNull()
    await act(async () => open.click())
    expect(h.createDocument).toHaveBeenCalledWith('ws', '/repo/' + path, type, undefined, { target: 'dock', zone: 'right', stackId: 'review-stack' })
    expect(h.createEditor).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()) }
})
