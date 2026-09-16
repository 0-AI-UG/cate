// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../../../shared/types'
import { isEditorDraft } from '../../../shared/editorDraft'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { captureEditorPanel, editorDocument, releaseEditorPanel } from './editorDocuments'
import { __resetModelCacheForTest } from './modelCache'
import { flushConnectedEditors, startConnectedEditorSync } from './connectedEditors'
import { preparePanelRelationContextForSend } from '../agent/panelRelationPrompt'

type WatchListener = (event: { path: string; type: string }) => void
const watches = vi.hoisted(() => new Map<WatchListener, string>())
vi.mock('../fs/fsWatchManager', () => ({
  watchFsRoot: (root: string, listener: WatchListener) => {
    watches.set(listener, root)
    return () => { watches.delete(listener) }
  },
}))

const disk = new Map<string, string>()
const read = vi.fn(async (path: string) => {
  if (!disk.has(path)) throw new Error('ENOENT')
  return disk.get(path)!
})
const write = vi.fn(async (path: string, content: string, _workspace: string, expected?: string | null) => {
  if (expected !== undefined && (disk.get(path) ?? null) !== expected) throw new Error('File changed')
  disk.set(path, content)
})
const saveDialog = vi.fn(async () => '/repo/notes.md')
let stop: (() => void) | undefined
let initialApp: ReturnType<typeof useAppStore.getState>
let initialSettings: ReturnType<typeof useSettingsStore.getState>

function workspace(): WorkspaceState {
  return {
    id: 'ws', rootPath: '/repo', name: 'Test', color: '#000',
    panels: {
      agent: { id: 'agent', type: 'agent', title: 'Agent', isDirty: false },
      editor: { id: 'editor', type: 'editor', title: 'Untitled', isDirty: false },
    },
    panelRelations: [{ id: 'link', fromPanelId: 'agent', toPanelId: 'editor', kind: 'use' }],
  } as WorkspaceState
}
function panel() { return useAppStore.getState().workspaces[0].panels.editor }
function doc() { return editorDocument('ws', 'editor', panel().filePath, '/repo') }
function buffer(content: string) {
  return { getValue: () => content, setValue: (value: string) => { content = value }, isDisposed: () => false }
}
async function externalWrite(path: string, content: string) {
  disk.set(path, content)
  for (const [listener] of watches) listener({ path, type: 'update' })
  await new Promise(resolve => setTimeout(resolve, 0))
}
beforeEach(() => {
  initialApp = useAppStore.getState()
  initialSettings = useSettingsStore.getState()
  __resetModelCacheForTest()
  disk.clear(); watches.clear(); vi.clearAllMocks()
  useAppStore.setState({ selectedWorkspaceId: 'ws', workspaces: [workspace()] })
  useSettingsStore.setState({ panelRelationsEnabled: true })
  Object.assign(window, { electronAPI: { fsReadFile: read, fsWriteFile: write, saveFileDialog: saveDialog } })
})
afterEach(() => {
  stop?.(); stop = undefined
  __resetModelCacheForTest()
  useAppStore.setState(initialApp, true)
  useSettingsStore.setState(initialSettings, true)
  vi.useRealTimers()
})

describe('connected editor working files', () => {
  it('materializes an untitled buffer before giving the agent a filesystem path', async () => {
    const model = buffer('User draft')
    const document = doc()
    document.attach({ getModel: () => model })
    document.noteUserEdit()
    const context = await preparePanelRelationContextForSend('ws', 'agent')
    expect(isEditorDraft(panel().filePath)).toBe(true)
    expect(disk.get(panel().filePath!)).toBe('User draft')
    expect(panel().title).toBe('Untitled')
    expect(panel().isDirty).toBe(false)
    expect(context).toContain(JSON.stringify(panel().filePath))
    expect(context).toContain('normal filesystem tools')
    expect(saveDialog).not.toHaveBeenCalled()
    expect([...watches.values()]).toContain('/repo/.cate/drafts')
    await externalWrite(panel().filePath!, 'Agent result')
    expect(model.getValue()).toBe('Agent result')
  })

  it('restores a clean draft from its backing file without a mounted view', async () => {
    await flushConnectedEditors('ws', 'agent')
    const path = panel().filePath!
    disk.set(path, 'Persisted draft')
    releaseEditorPanel('editor')
    await flushConnectedEditors('ws', 'agent')
    expect(doc().read()).toBe('Persisted draft')
    expect(panel().filePath).toBe(path)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('autosaves connected files after edits and stops when disconnected', async () => {
    vi.useFakeTimers()
    useAppStore.getState().updatePanelFilePath('ws', 'editor', '/repo/a.md')
    disk.set('/repo/a.md', 'Initial')
    const document = doc(), model = buffer('Initial')
    document.attach({ getModel: () => model }); document.noteLoaded('Initial')
    stop = startConnectedEditorSync()
    await flushConnectedEditors('ws', 'agent')
    model.setValue('User edit'); document.noteUserEdit()
    await vi.advanceTimersByTimeAsync(300)
    expect(disk.get('/repo/a.md')).toBe('User edit')
    expect(document.getSnapshot().shared).toBe(true)
    useAppStore.setState({ workspaces: [{ ...useAppStore.getState().workspaces[0], panelRelations: [] }] })
    await Promise.resolve()
    model.setValue('Unshared edit'); document.noteUserEdit()
    await vi.advanceTimersByTimeAsync(400)
    expect(disk.get('/repo/a.md')).toBe('User edit')
    expect(document.getSnapshot().shared).toBe(false)
  })

  it('flushes pending edits immediately and preserves both sides of a conflict', async () => {
    useAppStore.getState().updatePanelFilePath('ws', 'editor', '/repo/a.md')
    disk.set('/repo/a.md', 'Initial')
    const document = doc(), model = buffer('Initial')
    document.attach({ getModel: () => model }); document.noteLoaded('Initial')
    model.setValue('User edit'); document.noteUserEdit()
    await flushConnectedEditors('ws', 'agent')
    expect(disk.get('/repo/a.md')).toBe('User edit')
    model.setValue('Next user edit'); document.noteUserEdit()
    await externalWrite('/repo/a.md', 'Agent edit')
    await expect(preparePanelRelationContextForSend('ws', 'agent')).rejects.toThrow('Resolve its editor conflict')
    expect(model.getValue()).toBe('Next user edit')
    expect(disk.get('/repo/a.md')).toBe('Agent edit')
    expect(document.getSnapshot().conflict).toEqual({ kind: 'changed', diskContent: 'Agent edit' })
    expect(useAppStore.getState().workspaces[0].panels.agent.panelRelationContextMode).toBeUndefined()
  })

  it('keeps edits made while the initial draft is being written', async () => {
    const document = doc(), model = buffer('First')
    document.attach({ getModel: () => model }); document.noteUserEdit()
    let finish!: () => void
    write.mockImplementationOnce((path, content) => new Promise<void>(resolve => {
      finish = () => { disk.set(path, content); resolve() }
    }))
    const flushing = flushConnectedEditors('ws', 'agent')
    model.setValue('Second'); document.noteUserEdit()
    finish(); await flushing
    expect(disk.get(panel().filePath!)).toBe('Second')
    expect(model.getValue()).toBe('Second')
  })

  it('does not lose a keystroke or invent a conflict on its own save notification', async () => {
    useAppStore.getState().updatePanelFilePath('ws', 'editor', '/repo/a.md')
    disk.set('/repo/a.md', 'Initial')
    const document = doc(), model = buffer('Initial')
    document.attach({ getModel: () => model }); document.noteLoaded('Initial')
    model.setValue('First'); document.noteUserEdit()
    let finish!: () => void
    write.mockImplementationOnce((path, content) => new Promise<void>(resolve => {
      finish = () => { disk.set(path, content); resolve() }
    }))
    const flushing = document.flushShared()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    model.setValue('Second'); document.noteUserEdit()
    finish(); expect(await flushing).toBe(false)
    await externalWrite('/repo/a.md', 'First')
    expect(document.getSnapshot().conflict).toBeNull()
    expect(captureEditorPanel(panel()).unsavedContent).toBe('Second')
    expect(await document.flushShared()).toBe(true)
    expect(disk.get('/repo/a.md')).toBe('Second')
  })

  it('Save As promotes the draft and preserves the old working file', async () => {
    await flushConnectedEditors('ws', 'agent')
    const original = panel().filePath!
    await externalWrite(original, 'Agent result')
    expect(await doc().save()).toBe(true)
    expect(saveDialog).toHaveBeenCalledOnce()
    expect(panel().filePath).toBe('/repo/notes.md')
    expect(panel().title).toBe('notes.md')
    expect(disk.get('/repo/notes.md')).toBe('Agent result')
    expect(disk.get(original)).toBe('Agent result')
  })

  it('retains the draft when Save As is cancelled', async () => {
    await flushConnectedEditors('ws', 'agent')
    const original = panel().filePath
    saveDialog.mockResolvedValueOnce('')
    expect(await doc().save()).toBe(false)
    expect(panel().filePath).toBe(original)
  })

  it('does not autosave over an unreadable or deleted file', async () => {
    useAppStore.getState().updatePanelFilePath('ws', 'editor', '/repo/a.md')
    const document = doc(), model = buffer('Mine')
    document.attach({ getModel: () => model }); document.noteLoaded('Before'); document.noteUserEdit()
    await expect(flushConnectedEditors('ws', 'agent')).rejects.toThrow('Could not sync')
    expect(write).not.toHaveBeenCalled()
    expect(captureEditorPanel(panel()).unsavedContent).toBe('Mine')
    expect(document.getSnapshot().syncError).toContain('Could not read')
  })

  it('does not publish a draft path when its write fails', async () => {
    write.mockRejectedValueOnce(new Error('Disk full'))
    await expect(preparePanelRelationContextForSend('ws', 'agent')).rejects.toThrow('Could not sync')
    expect(panel().filePath).toBeUndefined()
    expect(doc().getSnapshot().syncError).toBe('Disk full')
  })

  it('uses a remote checkout locator for I/O and a native path in agent context', async () => {
    const ws = workspace()
    ws.rootPath = 'cate-runtime://server/repo'
    ws.worktrees = [{ id: 'branch', path: 'cate-runtime://server/worktrees/topic' }] as WorkspaceState['worktrees']
    ws.panels.editor.worktreeId = 'branch'
    useAppStore.setState({ workspaces: [ws] })
    const context = await preparePanelRelationContextForSend('ws', 'agent')
    expect(panel().filePath).toMatch(/^cate-runtime:\/\/server\/worktrees\/topic\/\.cate\/drafts\//)
    expect(context).toContain('"/worktrees/topic/.cate/drafts/')
    expect(context).not.toContain('cate-runtime:')
  })

  it('leaves previews and unconnected editors untouched', async () => {
    const ws = workspace()
    ws.panels.editor.filePath = '/repo/image.png'
    ws.panels.unconnected = { id: 'unconnected', type: 'editor', title: 'Untitled', isDirty: false }
    useAppStore.setState({ workspaces: [ws] })
    stop = startConnectedEditorSync()
    await flushConnectedEditors('ws', 'agent')
    expect(write).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(ws.panels.unconnected.filePath).toBeUndefined()
  })
})
