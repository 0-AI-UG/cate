import { parseLocator, formatLocator } from '../../../shared/runtimeLocator'
import { pathKey } from '../../../shared/pathUtils'
// Document state outlives Monaco views. One file has one buffer/baseline and one
// save/conflict owner; panel-specific presentation stays in EditorPanel.
import { notifySessionMutation } from '../workspace/sessionMutations'
import { capturePanelSearch } from '../../stores/panelSearchStores'
import type { PanelState, FileEntryMoved } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { watchFsRoot } from '../fs/fsWatchManager'
import { pathDisplayName } from '../fs/displayPath'
import { getBaseline, rememberBaseline, getCachedModel, isLoadFailed, onModelCacheReset, forgetModel, retireModel, retireModelsMatching } from './modelCache'
import { shouldBlockOverwrite } from './externalConflict'
import { threeWayMerge } from './threeWayMerge'
import log from '../logger'

export type EditorConflict = { kind: 'changed'; diskContent?: string } | { kind: 'deleted' } | null
interface BufferModel { getValue(): string; setValue(value: string): void; isDisposed(): boolean }
interface Owner { workspaceId: string; panelId: string; rootPath?: string }
interface View { getModel: () => BufferModel | null; onReplace?: (content: string) => void }
const documents = new Map<string, EditorDocument>()
const panelDocuments = new Map<string, EditorDocument>()
const keyFor = (panelId: string, path?: string) => path ?? `scratch:${panelId}`

export class EditorDocument {
  readonly filePathRef: { current: string | undefined }
  readonly isDirtyRef = { current: false }
  private baseline: string | null
  private content: string | undefined
  private replacing = false
  private state: { conflict: EditorConflict; showDiff: boolean } = { conflict: null, showDiff: false }
  private listeners = new Set<() => void>()
  private views = new Set<View>()
  readonly owners = new Map<string, Owner>()
  private stopWatching: (() => void) | undefined
  private watchEpoch = 0
  private watchKey: string | undefined
  private saving: Promise<boolean> | null = null
  private identityRevision = 0
  constructor(path: string | undefined, panel?: PanelState) {
    this.filePathRef = { current: path }
    this.content = panel?.unsavedContent
    this.baseline = panel?.editorBaseline ?? (path ? getBaseline(path) : undefined) ?? null
    this.isDirtyRef.current = panel?.unsavedContent !== undefined && (this.baseline === null || panel.unsavedContent !== this.baseline)
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = () => this.state
  private publish(patch: Partial<typeof this.state> = {}): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private model(): BufferModel | undefined {
    for (const view of this.views) { const model = view.getModel(); if (model && !model.isDisposed()) return model }
    const model = this.filePathRef.current ? getCachedModel(this.filePathRef.current) : undefined
    return model && !model.isDisposed() && 'getValue' in model && 'setValue' in model ? model as BufferModel : undefined
  }
  read = (): string | undefined => this.model()?.getValue() ?? this.content
  attach(view: View): () => void {
    this.views.add(view)
    const app = useAppStore.getState()
    for (const owner of this.owners.values()) {
      const panel = app.workspaces.find(ws => ws.id === owner.workspaceId)?.panels[owner.panelId]
      if (panel && panel.isDirty !== this.isDirtyRef.current) app.setPanelDirty(owner.workspaceId, owner.panelId, this.isDirtyRef.current)
    }
    this.watch()
    return () => { this.content = this.read(); this.views.delete(view) }
  }
  private owner(): Owner | undefined { return this.owners.values().next().value }
  addOwner(owner: Owner): void {
    this.owners.set(owner.panelId, owner)
    if (this.views.size || this.stopWatching) this.watch()
  }
  removeOwner(panelId: string): void {
    this.owners.delete(panelId)
    this.watch()
  }
  private markDirty(dirty: boolean): void {
    this.isDirtyRef.current = dirty
    const app = useAppStore.getState()
    for (const owner of this.owners.values()) {
      app.setPanelDirty(owner.workspaceId, owner.panelId, dirty)
      const path = this.filePathRef.current
      if (path) app.updatePanelTitle(owner.workspaceId, owner.panelId, `${pathDisplayName(path) || 'Untitled'}${dirty ? ' •' : ''}`)
      // Clearing persisted recovery data is necessary after save/discard, so a
      // remount never revives an old snapshot over a clean live document.
      if (!dirty) app.setPanelUnsavedContent(owner.workspaceId, owner.panelId, undefined)
    }
    this.publish()
  }
  private setBaseline(content: string): void {
    this.baseline = content
    if (this.filePathRef.current) rememberBaseline(this.filePathRef.current, content)
  }
  noteLoaded = (content: string): void => { this.setBaseline(content); this.content = this.read() }
  noteUserEdit = (): void => {
    this.content = this.read()
    if (!this.isDirtyRef.current) this.markDirty(true)
    notifySessionMutation()
  }
  isExternalReplace = (): boolean => this.replacing
  private replace(content: string): void {
    this.content = content
    this.replacing = true
    try {
      const seen = new Set<BufferModel>()
      for (const view of this.views) {
        const model = view.getModel()
        if (model && !model.isDisposed() && !seen.has(model)) { seen.add(model); model.setValue(content) }
        view.onReplace?.(content)
      }
      const cached = this.filePathRef.current ? getCachedModel(this.filePathRef.current) as BufferModel | undefined : undefined
      if (cached && !cached.isDisposed() && !seen.has(cached)) cached.setValue(content)
    } finally { this.replacing = false }
  }
  private applyDisk(content: string): void {
    if (this.read() === content) {
      this.setBaseline(content); this.markDirty(false); this.publish({ conflict: null }); return
    }
    if (this.isDirtyRef.current) { this.publish({ conflict: { kind: 'changed', diskContent: content } }); return }
    this.replace(content); this.setBaseline(content); this.publish({ conflict: null })
  }
  private watch(): void {
    const path = this.filePathRef.current
    const owner = [...this.owners.values()].find(candidate => candidate.rootPath)
    const key = path && owner?.rootPath ? JSON.stringify([path, owner.rootPath, owner.workspaceId]) : undefined
    if (key === this.watchKey) return
    this.watchEpoch++
    this.stopWatching?.()
    this.stopWatching = undefined
    this.watchKey = key
    if (!path || !owner?.rootPath) return
    const epoch = this.watchEpoch
    this.stopWatching = watchFsRoot(owner.rootPath, event => {
      if (event.path.replace(/\\/g, '/') !== path.replace(/\\/g, '/')) return
      const read = async (): Promise<void> => {
        try {
          const content = await window.electronAPI.fsReadFile(path, owner.workspaceId)
          if (epoch === this.watchEpoch) this.applyDisk(content)
        } catch {
          if (epoch === this.watchEpoch && event.type === 'delete') {
            this.noteUserEdit(); this.publish({ conflict: { kind: 'deleted' } })
          }
        }
      }
      if (event.type === 'delete') window.setTimeout(() => { if (epoch === this.watchEpoch) void read() }, 150)
      else void read()
    }, owner.workspaceId)
  }
  resyncFromDisk = async (): Promise<void> => {
    const path = this.filePathRef.current
    const owner = this.owner()
    if (!path || !owner) return
    const baseline = this.baseline ?? getBaseline(path)
    if (baseline === undefined || baseline === null) return
    this.baseline = baseline
    if (this.read() !== baseline) this.markDirty(true)
    try {
      const content = await window.electronAPI.fsReadFile(path, owner.workspaceId)
      if (content !== baseline) this.applyDisk(content)
    } catch { /* retain recovered edits if the file is temporarily unavailable */ }
  }
  save = (): Promise<boolean> => {
    if (!this.saving) this.saving = this.performSave().finally(() => { this.saving = null })
    return this.saving
  }
  private async performSave(): Promise<boolean> {
    const revision = this.identityRevision
    const owner = this.owner()
    const content = this.read()
    if (!owner || content === undefined) return false
    let target = this.filePathRef.current
    if (target && isLoadFailed(target)) return false
    const initial = !target
    if (!target) {
      const panel = useAppStore.getState().workspaces.find(ws => ws.id === owner.workspaceId)?.panels[owner.panelId]
      const name = panel?.title.replace(/\s•\s*$/, '').trim()
      const defaultName = name && name !== 'Untitled' ? name : 'Untitled.txt'
      const chosen = await window.electronAPI.saveFileDialog({ defaultName, defaultPath: owner.rootPath ? `${owner.rootPath}/${defaultName}` : defaultName })
      if (!chosen || revision !== this.identityRevision) return false
      target = chosen
    }
    const existing = initial ? documents.get(target) : undefined
    if (existing && existing !== this && existing.isDirtyRef.current && existing.read() !== content) {
      this.publish({ conflict: { kind: 'changed', diskContent: existing.read() } })
      return false
    }
    let expectedDiskContent: string | null | undefined
    if (!initial && this.baseline !== null) {
      let disk: string | null = null
      try { disk = await window.electronAPI.fsReadFile(target, owner.workspaceId) } catch { /* deleted: saving restores */ }
      expectedDiskContent = disk
      if (revision !== this.identityRevision) return false
      if (shouldBlockOverwrite(this.baseline, disk, content)) {
        this.publish({ conflict: { kind: 'changed', diskContent: disk ?? undefined } }); return false
      }
    }
    try { await window.electronAPI.fsWriteFile(target, content, owner.workspaceId, expectedDiskContent) }
    catch (error) { log.error('[editor] Save failed:', error); return false }
    if (revision !== this.identityRevision) return false
    const latest = this.read()
    this.filePathRef.current = target
    this.setBaseline(content)
    if (initial) {
      documents.delete(keyFor(owner.panelId))
      if (existing && existing !== this) {
        existing.replace(latest ?? content)
        existing.setBaseline(content)
        for (const [id, own] of this.owners) { existing.addOwner(own); panelDocuments.set(id, existing) }
        this.owners.clear()
        existing.markDirty(latest !== content)
        for (const own of existing.owners.values()) useAppStore.getState().updatePanelFilePath(own.workspaceId, own.panelId, target)
        this.dispose()
        return !existing.isDirtyRef.current
      }
      documents.set(target, this)
      this.replace(latest ?? content)
      for (const own of this.owners.values()) useAppStore.getState().updatePanelFilePath(own.workspaceId, own.panelId, target)
      this.watch()
    }
    this.markDirty(latest !== content)
    this.publish({ conflict: null })
    // An edit during the asynchronous save is still unsaved and must block close.
    return !this.isDirtyRef.current
  }
  discard = async (): Promise<void> => {
    const owner = this.owner()
    const path = this.filePathRef.current
    let content = ''
    if (path && owner) {
      try { content = await window.electronAPI.fsReadFile(path, owner.workspaceId) }
      catch { /* A deleted file can still be discarded. */ }
    }
    this.replace(content); this.setBaseline(content); this.markDirty(false); this.publish({ conflict: null, showDiff: false })
  }
  reload = (): void => {
    const content = this.state.conflict?.kind === 'changed' ? this.state.conflict.diskContent ?? '' : ''
    this.replace(content); this.setBaseline(content); this.markDirty(false); this.publish({ conflict: null, showDiff: false })
  }
  keepMine = (): void => {
    if (this.state.conflict?.kind === 'changed' && this.state.conflict.diskContent !== undefined) this.setBaseline(this.state.conflict.diskContent)
    this.publish({ conflict: null, showDiff: false })
  }
  keepBoth = (): void => {
    if (this.state.conflict?.kind !== 'changed') return
    const theirs = this.state.conflict.diskContent ?? ''
    const { merged } = threeWayMerge(this.baseline ?? '', this.read() ?? '', theirs, { mine: 'Your changes', theirs: 'On disk' })
    this.replace(merged); this.setBaseline(theirs); this.markDirty(true); this.publish({ conflict: null, showDiff: false })
  }
  saveToRestore = async (): Promise<void> => { if (await this.save()) this.publish({ conflict: null, showDiff: false }) }
  dismiss = (): void => this.publish({ conflict: null, showDiff: false })
  openDiff = (): void => this.publish({ showDiff: true })
  closeDiff = (): void => this.publish({ showDiff: false })
  snapshot(panel: PanelState): PanelState {
    const content = this.read()
    return { ...panel, isDirty: this.isDirtyRef.current, unsavedContent: this.isDirtyRef.current ? content : undefined, editorBaseline: this.isDirtyRef.current ? this.baseline ?? undefined : undefined }
  }
  synchronizeViews(document: EditorDocument): void {
    const content = this.read()
    if (content !== undefined) document.replace(content)
  }
  relocate(target: string | undefined): void {
    this.identityRevision++
    this.content = this.read()
    this.filePathRef.current = target
    if (target && this.baseline !== null) rememberBaseline(target, this.baseline)
    this.watch()
    this.publish({ conflict: null, showDiff: false })
  }
  dispose(): void { this.identityRevision++; this.watchEpoch++; this.stopWatching?.(); this.stopWatching = undefined; this.watchKey = undefined; this.listeners.clear() }
}

export function editorDocument(workspaceId: string, panelId: string, filePath?: string | null, rootPath?: string): EditorDocument {
  const panel = useAppStore.getState().workspaces.find(ws => ws.id === workspaceId)?.panels[panelId]
  filePath = filePath === null ? undefined : filePath ?? panel?.filePath
  const previous = panelDocuments.get(panelId)
  if (previous && previous.filePathRef.current !== filePath) releaseEditorPanel(panelId)
  const key = keyFor(panelId, filePath)
  let document = documents.get(key)
  if (!document) {
    document = new EditorDocument(filePath, panel)
    documents.set(key, document)
  }
  document.addOwner({ workspaceId, panelId, rootPath })
  panelDocuments.set(panelId, document)
  return document
}
export function saveEditorDocument(panelId: string): Promise<boolean> | undefined {
  let document = panelDocuments.get(panelId)
  if (!document) {
    const ws = useAppStore.getState().workspaces.find(ws => ws.panels[panelId])
    const panel = ws?.panels[panelId]
    if (ws && panel?.type === 'editor' && panel.unsavedContent !== undefined) document = editorDocument(ws.id, panelId, panel.filePath, ws.rootPath)
  }
  return document?.save()
}
/** Current bytes for close preparation, including clean buffers whose watcher
 * metadata may change while an already-approved disk operation is running. */
export function editorPanelContent(panel: PanelState): string | undefined {
  if (panel.type !== 'editor') return undefined
  const document = panelDocuments.get(panel.id) ?? (panel.filePath ? documents.get(panel.filePath) : undefined)
  if (document) return document.read()
  const model = panel.filePath ? getCachedModel(panel.filePath) as BufferModel | undefined : undefined
  return model && !model.isDisposed() && model.getValue ? model.getValue() : panel.unsavedContent
}
export function captureEditorPanel(panel: PanelState): PanelState {
  if (panel.type !== 'editor') return panel
  panel = capturePanelSearch(panel)
  const document = panelDocuments.get(panel.id) ?? (panel.filePath ? documents.get(panel.filePath) : undefined)
  if (document) return document.snapshot(panel)
  const model = panel.filePath ? getCachedModel(panel.filePath) as BufferModel | undefined : undefined
  if (panel.isDirty && model && !model.isDisposed() && model.getValue) return { ...panel, unsavedContent: model.getValue(), editorBaseline: getBaseline(panel.filePath!) }
  return panel
}
export function releaseEditorPanel(panelId: string): void {
  const document = panelDocuments.get(panelId)
  if (!document) return
  panelDocuments.delete(panelId); document.removeOwner(panelId)
  if (document.owners.size) return
  document.dispose()
  const path = document.filePathRef.current
  for (const [key, owner] of documents) if (owner === document) documents.delete(key)
  if (path && document.isDirtyRef.current) forgetModel(path)
}
onModelCacheReset(() => {
  documents.forEach(document => document.dispose())
  documents.clear(); panelDocuments.clear()
})

/** Follow an acknowledged runtime move in every owning renderer. External
 * delete/create events cannot infer this identity relationship themselves. */
export function applyFileEntryMove(event: FileEntryMoved): void {
  const from = parseLocator(event.from), to = parseLocator(event.to)
  const sourceKey = pathKey(from.path)
  const movedPath = (path: string | undefined): string | undefined => {
    if (!path) return undefined
    const parsed = parseLocator(path), key = pathKey(parsed.path)
    if (parsed.runtimeId !== from.runtimeId || (key !== sourceKey && !key.startsWith(sourceKey + '/'))) return undefined
    const suffix = parsed.path.replace(/\\/g, '/').slice(from.path.replace(/\\/g, '/').replace(/\/$/, '').length)
    return formatLocator({ runtimeId: to.runtimeId, path: to.path.replace(/\/$/, '') + suffix })
  }
  const app = useAppStore.getState()
  const movedPanels = app.workspaces.flatMap(ws => Object.values(ws.panels).flatMap(panel => {
    const path = panel.type === 'editor' ? movedPath(panel.filePath) : undefined
    return path ? [{ workspaceId: ws.id, panel, path }] : []
  }))
  for (const [oldPath, document] of [...documents]) {
    const target = movedPath(document.filePathRef.current)
    if (!target) continue
    const existing = documents.get(target)
    if (existing && existing !== document) {
      documents.delete(target)
      if (existing.isDirtyRef.current) {
        // The filesystem move already overwrote this destination. Keep its
        // unsaved buffer recoverable instead of merging two distinct edits.
        existing.relocate(undefined)
        for (const owner of existing.owners.values()) {
          documents.set(keyFor(owner.panelId), existing)
          app.setPanelUnsavedContent(owner.workspaceId, owner.panelId, existing.read())
          app.updatePanelFilePath(owner.workspaceId, owner.panelId, undefined)
        }
      } else {
        document.synchronizeViews(existing)
        for (const owner of existing.owners.values()) {
          document.addOwner(owner); panelDocuments.set(owner.panelId, document)
          app.setPanelDirty(owner.workspaceId, owner.panelId, document.isDirtyRef.current)
        }
        existing.owners.clear(); existing.dispose()
      }
      retireModel(target)
    }
    documents.delete(oldPath)
    document.relocate(target)
    documents.set(target, document)
    retireModel(oldPath)
  }
  retireModelsMatching(path => movedPath(path) !== undefined)
  for (const { workspaceId, panel, path } of movedPanels) {
    app.updatePanelFilePath(workspaceId, panel.id, path)
    app.updatePanelTitle(workspaceId, panel.id, `${pathDisplayName(path)}${panel.isDirty ? ' •' : ''}`)
  }
}
