// The explorer's tree state over the workspace's runtime: directory reads,
// their cache, expansion, selection and the watch. It outlives the mounted
// view (its owner decides when to dispose it) and is shared by the Files
// sidebar and the editor's explorer.

import { createLogger } from '@kernel/log/contract'
import { clientUi, errorMessage } from '@kernel/interaction'
import { pathDisplayName, type FileEntry, type FileRef } from '../contract'
import { createExplorerRefresh } from './explorerRefresh'
import { fileRefs, type FileRefs } from './fileRefs'
import { fsClient, type FsClient, type ImportSource } from './fsClient'
import { watchFsRoot, type FsWatchListener } from './watchManager'
import './clientUi'

const log = createLogger('file-explorer')

export interface FileTreeSnapshot {
  nodes: FileEntry[]
  childrenCache: Map<string, FileEntry[]>
  loadingPaths: Set<string>
  expandedPaths: Set<string>
  selectedPaths: Set<string>
  isLoading: boolean
  loadError: string | null
}

/** What a view persists of the tree. */
export interface FileTreeSavedState {
  rootPath: string
  expandedPaths: string[]
  selectedPaths: string[]
}

/** Files dropped from outside Cate: how many, and how to read them once
 *  the person confirmed. */
export interface DroppedImport {
  count: number
  read(): Promise<ImportSource[]>
}

export type FileTreeFs = Pick<FsClient, 'readDir' | 'mkdir' | 'write' | 'rename' | 'copy' | 'remove'>

export interface FileTreeModelOptions {
  /** Paints a warm tree (from an earlier model) while it revalidates. */
  seed?: FileTreeSnapshot
  saved?: FileTreeSavedState
  /** Defaults to the workspace's fs client. */
  fs?: () => FileTreeFs
  /** Defaults to the shared file-ref resolver. */
  refs?: FileRefs
  /** Defaults to the shared watch manager. */
  watch?: (workspaceId: string, root: string, listener: FsWatchListener) => () => void
  /** Called when expansion or selection changes, so the owner can persist. */
  onStateChange?: () => void
}

type Update = Set<string> | ((previous: Set<string>) => Set<string>)

export class FileTreeModel {
  private state: FileTreeSnapshot
  private listeners = new Set<() => void>()
  private requests = new Map<string, Promise<void>>()
  private refreshQueue: ReturnType<typeof createExplorerRefresh<FileEntry[]>> | undefined
  private unwatch: (() => void) | undefined
  private disposed = false
  private readonly fs: () => FileTreeFs
  private readonly refs: FileRefs
  private readonly watch: NonNullable<FileTreeModelOptions['watch']>

  constructor(readonly rootPath: string, readonly workspaceId: string, private readonly options: FileTreeModelOptions = {}) {
    const { seed, saved } = options
    this.fs = options.fs ?? (() => fsClient(workspaceId))
    this.refs = options.refs ?? fileRefs
    this.watch = options.watch ?? watchFsRoot
    this.state = seed ? { ...seed, loadingPaths: new Set(), isLoading: false, loadError: null } : {
      nodes: [], childrenCache: new Map(), loadingPaths: new Set(), expandedPaths: new Set(), selectedPaths: new Set(), isLoading: !!rootPath, loadError: null,
    }
    if (saved?.rootPath === rootPath) this.state = { ...this.state, expandedPaths: new Set(saved.expandedPaths), selectedPaths: new Set(saved.selectedPaths) }
  }

  capture = (): FileTreeSavedState => ({ rootPath: this.rootPath, expandedPaths: [...this.state.expandedPaths], selectedPaths: [...this.state.selectedPaths] })
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = (): FileTreeSnapshot => this.state

  private checkOpen(): void { if (this.disposed) throw new Error('File panel scope is closed') }

  create = async (path: string, type: 'file' | 'folder'): Promise<void> => {
    this.checkOpen()
    if (type === 'folder') await this.fs().mkdir(path)
    else await this.fs().write(path, '', null)
  }
  rename = async (from: string, to: string): Promise<void> => { this.checkOpen(); await this.fs().rename(from, to) }
  copy = async (from: string, directory: string): Promise<void> => { this.checkOpen(); await this.fs().copy(from, directory) }
  delete = async (path: string): Promise<void> => { this.checkOpen(); await this.fs().remove(path) }

  /** Uploads files dropped from the OS into destDir after this client
   *  confirms. True when anything was imported. */
  importDropped = async (dropped: DroppedImport, destDir: string, destName?: string): Promise<boolean> => {
    if (this.disposed || !destDir || dropped.count === 0) return false
    try {
      const ask = clientUi().confirmImportEntries
      if (ask) {
        const choice = await ask({ count: dropped.count, destName: destName ?? pathDisplayName(destDir) })
        if (choice === 'cancel' || this.disposed) return false
      }
      const sources = await dropped.read()
      if (this.disposed) return false
      return (await this.refs.upload(sources, { workspaceId: this.workspaceId, destDir })).length > 0
    } catch (error) {
      log.error('import failed:', error)
      return false
    }
  }

  /** Moves or copies files (of this or any other workspace) into destDir;
   *  see `FileRefs.transfer`. True when anything changed. */
  transfer = async (refs: readonly FileRef[], destDir: string, mode: 'move' | 'copy'): Promise<boolean> => {
    if (this.disposed || !destDir || refs.length === 0) return false
    try {
      return (await this.refs.transfer(refs, { workspaceId: this.workspaceId, destDir }, mode)).length > 0
    } catch (error) {
      log.error(`${mode} failed:`, error)
      return false
    }
  }

  private publish(patch: Partial<FileTreeSnapshot>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  setExpandedPaths = (update: Update): void => {
    this.publish({ expandedPaths: typeof update === 'function' ? update(this.state.expandedPaths) : update })
    this.options.onStateChange?.()
  }
  setSelectedPaths = (update: Update): void => {
    this.publish({ selectedPaths: typeof update === 'function' ? update(this.state.selectedPaths) : update })
    this.options.onStateChange?.()
  }

  activate = (): void => {
    if (this.disposed || this.refreshQueue || !this.rootPath) return
    this.refreshQueue = createExplorerRefresh({
      root: this.rootPath,
      loaded: () => [...this.state.childrenCache.keys(), ...this.requests.keys()],
      read: async (path) => {
        for (let attempt = 0; ; attempt++) {
          if (this.disposed) return []
          try { return await this.fs().readDir(path) }
          catch (error) {
            if (this.disposed || path !== this.rootPath || attempt >= 5) throw error
            await new Promise<void>((resolve) => setTimeout(resolve, 120))
          }
        }
      },
      apply: (path, entries, error) => {
        if (path === this.rootPath) this.publish(error === undefined
          ? { nodes: entries ?? [], isLoading: false, loadError: null }
          : { isLoading: false, loadError: errorMessage(error, 'Could not load files.') })
        else {
          const childrenCache = new Map(this.state.childrenCache)
          if (entries) childrenCache.set(path, entries); else childrenCache.delete(path)
          this.publish({ childrenCache })
        }
        if (!entries) this.setExpandedPaths((previous) => { const next = new Set(previous); next.delete(path); return next })
      },
      remove: (path) => {
        const normalized = path.replace(/\\/g, '/')
        const under = (key: string) => { const value = key.replace(/\\/g, '/'); return value === normalized || value.startsWith(normalized + '/') }
        this.publish({
          childrenCache: new Map([...this.state.childrenCache].filter(([key]) => !under(key))),
          expandedPaths: new Set([...this.state.expandedPaths].filter((key) => !under(key))),
        })
      },
    })
    void this.refreshQueue.request(this.rootPath)
    this.refreshQueue.refresh(this.state.childrenCache.keys())
    this.unwatch = this.watch(this.workspaceId, this.rootPath, this.refreshQueue.event)
    for (const path of this.state.expandedPaths) void this.ensureChildrenLoaded(path).catch(() => {})
  }

  ensureChildrenLoaded = (path: string): Promise<void> => {
    this.activate()
    if (this.state.childrenCache.has(path)) return Promise.resolve()
    const pending = this.requests.get(path)
    if (pending) return pending
    if (!this.refreshQueue) return Promise.resolve()
    this.publish({ loadingPaths: new Set(this.state.loadingPaths).add(path) })
    const request = this.refreshQueue.request(path).finally(() => {
      this.requests.delete(path)
      const loadingPaths = new Set(this.state.loadingPaths); loadingPaths.delete(path)
      this.publish({ loadingPaths })
    })
    this.requests.set(path, request)
    return request
  }

  /** Reconnecting is the connection's job; a retry just reads again. */
  retry = async (): Promise<void> => {
    if (!this.disposed) this.refresh()
  }

  refresh = (): void => { this.activate(); this.refreshQueue?.refresh([this.rootPath, ...this.state.childrenCache.keys()]) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.refreshQueue?.dispose()
    this.unwatch?.()
    this.listeners.clear()
  }
}
