// The editor session (architecture 11.3): binds its panel to the open buffer
// of one file and owns everything around it: save and Save As, conflicts,
// a conflict's shared diff, following a renamed file, and sharing with an agent
// (connected editors, docs/connected-editors.md). The text itself is the
// buffer's Yjs document; views attach to it through `file.buffer`.

import { randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { sessionApi } from '@kernel/api/contract'
import { RpcError, isRpcError } from '@kernel/rpc/contract'
import type { PanelId, PanelRecord } from '@workspace/document/contract'
import {
  getDocumentType,
  pathDisplayName,
  pathHasPrefix,
  pathKey,
  textDelta,
  type BufferResolution,
  type BufferState,
} from '@workspace/files/contract'
import type { BufferHandle, BufferService } from '@workspace/files/runtime'
import { ensureCateGitignore } from '@workspace/lifecycle/runtime'
import { DRAFTS_DIR, editorDraftPath, isEditorDraft } from '@workspace/relations/contract'
import type { SharedEditor } from '@workspace/relations/runtime'
import { PanelSession, type DisposeReason, type OpHandlers, type SessionKit } from '@panels/framework/runtime'
import { editorApi, type EditorOp, type EditorSnapshot } from './contract'

export interface EditorSessionDeps {
  /** Canonical workspace root; untitled editors outside a worktree draft here. */
  root: string
  buffers: Pick<BufferService, 'open'>
  /** Every successful rename (`FilesRuntime.onMoved`); the session follows its file. */
  onMoved?(listener: (from: string, to: string) => void): () => void
  /** Connected editors, told when a session starts late. */
  connected?: { reconcile(): void }
  /** Autosave delay while shared with an agent. */
  autosaveMs?: number
  newId?: () => string
}

const RESOLUTIONS: readonly BufferResolution[] = ['reload', 'keep', 'merge']
/** Origin of text the session writes into a buffer (Save As, relocation). */
const SESSION_ORIGIN = Symbol('editor-session')

export const filePathOf = (record: PanelRecord): string | undefined => {
  const value = record.fields.filePath
  return typeof value === 'string' && value ? value : undefined
}


/** Where `file` lands when `from` moved to `to`; undefined when unaffected. */
export function movedPath(file: string, from: string, to: string): string | undefined {
  if (pathKey(file) === pathKey(from)) return to
  if (!pathHasPrefix(pathKey(file), pathKey(from))) return undefined
  return to.replace(/[/\\]+$/, '') + file.slice(from.replace(/[/\\]+$/, '').length)
}

function replaceText(handle: BufferHandle, next: string): void {
  const delta = textDelta(handle.text.toString(), next)
  if (!delta) return
  handle.doc.transact(() => {
    if (delta.remove) handle.text.delete(delta.index, delta.remove)
    if (delta.insert) handle.text.insert(delta.index, delta.insert)
  }, SESSION_ORIGIN)
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

const initialSnapshot = (record: PanelRecord): EditorSnapshot => {
  const file = filePathOf(record) ?? null
  return {
    filePath: file,
    checkout: null,
    draft: !!file && isEditorDraft(file),
    documentType: file ? getDocumentType(file) : null,
    dirty: false,
    conflict: null,
    merging: false,
    connectedDraft: null,
    loading: true,
    error: null,
    reveal: null,
  }
}

export class EditorSession extends PanelSession<EditorSnapshot, EditorOp> implements SharedEditor {
  private handle: BufferHandle | null = null
  private boundPath: string | null = null
  private offHandle: Array<() => void> = []
  private offMoved: (() => void) | undefined
  /** Identity changes (bind, Save As, relocation, file switch) run one at a time. */
  private chain: Promise<unknown> = Promise.resolve()
  private shared = false
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined
  private revealSeq = 0

  constructor(kit: SessionKit, record: PanelRecord, private readonly deps: EditorSessionDeps) {
    super(kit, record, initialSnapshot(record))
  }

  override async start(): Promise<void> {
    this.offMoved = this.deps.onMoved?.((from, to) => { void this.followMove(from, to) })
    await this.exclusive(async () => {
      let file = filePathOf(this.record)
      if (!file) {
        // An untitled editor edits a draft; the file is written once shared or saved.
        file = editorDraftPath(this.checkout(), this.deps.newId?.() ?? randomUUID())
        await this.bind(file)
        this.writeRecord(file, { keepTitle: true })
      } else {
        await this.bind(file)
      }
    })
    this.deps.connected?.reconcile()
  }

  // ---- ops -------------------------------------------------------------------

  protected override readonly ops: OpHandlers<EditorOp> = {
    save: async () => this.save(),
    saveAs: ({ path: target }) => this.exclusive(() => this.saveAs(target)),
    showMerge: ({ show }) => {
      if (show && this.state.conflict !== 'changed') throw new RpcError('rejected', 'There is no on-disk change to compare')
      this.publish({ merging: show === true })
    },
    resolveConflict: async ({ resolution }) => {
      if (!RESOLUTIONS.includes(resolution)) throw new RpcError('rejected', `unknown resolution ${String(resolution)}`)
      const state = await this.requireHandle().resolveConflict(resolution)
      this.applyState(state)
      return { dirty: state.dirty }
    },
    openFile: ({ path: file, line, column, discard }) => this.exclusive(() => this.openFile(file, { line, column, discard })),
    switchWorktree: ({ worktreeId, discard }) => this.exclusive(() => this.switchWorktree(worktreeId, discard === true)),
    close: async ({ discard }) => {
      const blocker = discard === true ? null : this.closeBlocker(new Set([this.panelId]))
      if (blocker) throw blocker
      this.kit.document.apply({ kind: 'removePanels', ids: [this.panelId], ...(discard === true ? { discard: [this.panelId] } : {}) })
    },
    prepareClose: ({ closing }) => {
      const blocker = this.closeBlocker(new Set([this.panelId, ...(closing ?? [])]))
      if (blocker) throw blocker
    },
  }

  override handleApi = sessionApi(editorApi, {
    active: () => ({ panelId: this.panelId, filePath: this.state.filePath, dirty: this.state.dirty }),
  })

  /** Asks views to show a line (the `cate.editor.openFile` service). */
  reveal(line: number, column?: number): void {
    this.publish({ reveal: { seq: ++this.revealSeq, line, column: column ?? null } })
  }

  /** Unsaved edits are lost unless an editor outside the removal shows the
   *  same buffer. */
  override closeBlocker(removing: ReadonlySet<PanelId>): RpcError | null {
    if (!this.state.dirty || this.othersShow(this.boundPath, removing)) return null
    return new RpcError('dirty', `${this.record.title} has unsaved changes`, { panelId: this.panelId })
  }

  // ---- connected editors -----------------------------------------------------

  setShared(shared: boolean): void {
    if (this.disposed || this.shared === shared) return
    this.shared = shared
    clearTimeout(this.autosaveTimer)
    this.publish({ connectedDraft: shared ? { syncError: null } : null })
    if (shared) void this.flushShared()
  }

  /** Writes pending edits (and a draft's file) so the agent reads them. */
  async flushShared(): Promise<boolean> {
    clearTimeout(this.autosaveTimer)
    await this.chain.catch(() => {})
    const handle = this.handle
    if (this.disposed || !handle || this.state.documentType) return false
    const state = handle.state()
    if (state.conflict) return false
    if (!state.dirty && state.baseHash !== null) return true
    try {
      this.applyState(await this.saveHandle(handle))
      if (this.shared) this.publish({ connectedDraft: { syncError: null } })
      return true
    } catch (err) {
      // A conflict shows in the snapshot; anything else is a failed autosave.
      if (this.shared && !isRpcError(err, 'conflict')) {
        this.publish({ connectedDraft: { syncError: message(err, 'Could not sync the shared editor.') } })
      }
      return false
    }
  }

  // ---- behaviour -------------------------------------------------------------

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => {})
    return run
  }

  private checkout(): string {
    const worktree = this.record.worktreeId ? this.kit.document.get().worktrees[this.record.worktreeId] : undefined
    return worktree?.path ?? this.deps.root
  }

  /** The snapshot fields that follow the bound file. */
  private located(file: string): Pick<EditorSnapshot, 'filePath' | 'checkout' | 'draft' | 'documentType'> {
    const worktreeId = this.worktreeIdFor(file)
    const checkout = worktreeId ? this.kit.document.get().worktrees[worktreeId].path : this.deps.root
    return { filePath: file, checkout, draft: isEditorDraft(file), documentType: getDocumentType(file) }
  }

  private worktreeIdFor(file: string): string | null {
    let best: { id: string; length: number } | null = null
    for (const worktree of Object.values(this.kit.document.get().worktrees)) {
      const root = worktree.path.replace(/[/\\]+$/, '')
      if (pathHasPrefix(pathKey(file), pathKey(root)) && (!best || root.length > best.length)) best = { id: worktree.id, length: root.length }
    }
    return best?.id ?? null
  }

  /** Another open editor (not in `removing`) shows `file`, so its buffer
   *  outlives this panel. */
  private othersShow(file: string | null, removing: ReadonlySet<PanelId> = new Set()): boolean {
    if (!file) return false
    return Object.values(this.kit.document.get().panels).some((record) => {
      const other = record.id !== this.panelId && !removing.has(record.id) && record.type === 'editor' ? filePathOf(record) : undefined
      return !!other && pathKey(other) === pathKey(file)
    })
  }

  private requireHandle(): BufferHandle {
    if (this.state.documentType) throw new RpcError('rejected', 'This panel shows a preview, not text')
    if (!this.handle) throw new RpcError('rejected', this.state.error ?? 'The file is still loading')
    return this.handle
  }

  private async save(): Promise<{ path: string; dirty: boolean }> {
    await this.chain.catch(() => {})
    const state = await this.saveHandle(this.requireHandle())
    this.applyState(state)
    return { path: state.path, dirty: state.dirty }
  }

  private async saveHandle(handle: BufferHandle): Promise<BufferState> {
    if (isEditorDraft(handle.path)) await this.ensureDraftDir(handle.path)
    try {
      return await handle.save()
    } catch (err) {
      // The buffer re-read the disk; its conflict state is already current.
      this.applyState(handle.state())
      throw err
    }
  }

  private async ensureDraftDir(file: string): Promise<void> {
    const dir = path.dirname(file)
    const checkout = dir.slice(0, dir.length - DRAFTS_DIR.length - 1)
    await ensureCateGitignore(checkout)
    await mkdir(dir, { recursive: true })
  }

  /** Binds the panel to `file`: its buffer, or nothing for a preview (the
   *  view fetches preview bytes itself). Caller holds `exclusive`. */
  private async bind(file: string): Promise<void> {
    this.unbind()
    const documentType = getDocumentType(file)
    this.boundPath = file
    this.publish({ ...this.located(file), merging: false, dirty: false, conflict: null, loading: !documentType, error: null })
    if (documentType) return
    try {
      const handle = await this.deps.buffers.open(file)
      if (this.disposed || this.boundPath !== file) {
        handle.close()
        return
      }
      this.hold(handle)
      this.publish({ loading: false })
    } catch (err) {
      if (this.boundPath === file) this.publish({ loading: false, error: message(err, 'Could not open this file.') })
    }
  }

  private hold(handle: BufferHandle): void {
    this.handle = handle
    this.boundPath = handle.path
    this.applyState(handle.state())
    this.offHandle = [
      handle.subscribe((state) => this.applyState(state)),
      handle.onUpdate(() => this.scheduleAutosave()),
    ]
  }

  /** Stops following the bound buffer; returns it still open. */
  private unhook(): BufferHandle | null {
    clearTimeout(this.autosaveTimer)
    for (const off of this.offHandle) off()
    this.offHandle = []
    const handle = this.handle
    this.handle = null
    return handle
  }

  private unbind(): void {
    this.unhook()?.close()
  }

  private applyState(state: BufferState): void {
    if (this.disposed || !this.handle || pathKey(state.path) !== pathKey(this.handle.path)) return
    const conflict = state.conflict?.kind ?? null
    this.publish({ dirty: state.dirty, conflict, ...(conflict !== 'changed' ? { merging: false } : {}) })
  }

  private scheduleAutosave(): void {
    if (!this.shared || this.disposed) return
    clearTimeout(this.autosaveTimer)
    this.autosaveTimer = setTimeout(() => { void this.flushShared() }, this.deps.autosaveMs ?? 300)
  }

  /** Points the record at `file`. The session is already bound to it, so the
   *  record change it causes is a no-op here. */
  private writeRecord(file: string, { keepTitle = false } = {}): void {
    const worktreeId = this.worktreeIdFor(file)
    this.kit.document.apply({
      kind: 'updatePanel',
      id: this.panelId,
      patch: {
        ...(keepTitle ? {} : { title: pathDisplayName(file) }),
        ...(keepTitle || worktreeId === (this.record.worktreeId ?? null) ? {} : { worktreeId }),
        fields: { filePath: file },
      },
    })
  }

  /** Drops unsaved edits of a buffer nobody else shows, so it is released. */
  private async revertIfUnshown(handle: BufferHandle): Promise<void> {
    if (this.othersShow(handle.path)) return
    const state = handle.state()
    if (state.dirty || state.conflict) await handle.resolveConflict('reload').catch(() => {})
  }

  private async openFile(file: string, options: { line?: number; column?: number; discard?: boolean }): Promise<{ filePath: string }> {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new RpcError('rejected', 'openFile needs an absolute path')
    const current = this.boundPath
    if (!current || pathKey(current) !== pathKey(file)) {
      if (this.state.dirty && !options.discard && !this.othersShow(current)) {
        throw new RpcError('dirty', `${this.record.title} has unsaved changes`, { panelId: this.panelId })
      }
      const previous = this.unhook()
      if (previous) {
        if (options.discard) await this.revertIfUnshown(previous)
        previous.close()
      }
      await this.bind(file)
      this.writeRecord(file)
    }
    if (options.line !== undefined) this.reveal(options.line, options.column)
    return { filePath: file }
  }

  private async switchWorktree(worktreeId: string | null, discard: boolean): Promise<{ filePath: string }> {
    const target = worktreeId ? this.kit.document.get().worktrees[worktreeId] : { path: this.deps.root }
    if (!target) throw new RpcError('gone', `no worktree ${String(worktreeId)}`)
    const current = this.boundPath
    const from = this.state.checkout ?? this.deps.root
    if (current && pathKey(target.path) === pathKey(from)) return { filePath: current }
    if (this.state.dirty && !discard && !this.state.draft && !this.othersShow(current)) {
      throw new RpcError('dirty', `${this.record.title} has unsaved changes`, { panelId: this.panelId })
    }
    const relative = current && !this.state.draft ? path.relative(from, current) : null
    const counterpart = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join(target.path, relative) : null
    if (counterpart && (this.state.documentType || await access(counterpart).then(() => true, () => false))) {
      return this.openFile(counterpart, { discard: true })
    }
    // Missing there: a draft in that checkout carries the text across.
    const text = this.handle?.text.toString() ?? ''
    const previous = this.unhook()
    if (previous) {
      await this.revertIfUnshown(previous)
      previous.close()
    }
    const draft = editorDraftPath(target.path, this.deps.newId?.() ?? randomUUID())
    await this.bind(draft)
    if (this.handle) replaceText(this.handle, text)
    this.kit.document.apply({ kind: 'updatePanel', id: this.panelId, patch: { worktreeId: this.worktreeIdFor(draft), fields: { filePath: draft } } })
    return { filePath: draft }
  }

  private async saveAs(target: string): Promise<{ path: string; dirty: boolean }> {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new RpcError('rejected', 'saveAs needs an absolute path')
    const source = this.requireHandle()
    if (pathKey(target) === pathKey(source.path)) {
      const state = await this.saveHandle(source)
      this.applyState(state)
      return { path: state.path, dirty: state.dirty }
    }
    const content = source.text.toString()
    const dest = await this.deps.buffers.open(target)
    let state: BufferState
    try {
      if (dest.state().dirty && dest.text.toString() !== content) {
        throw new RpcError('conflict', `${pathDisplayName(target)} has unsaved changes in another editor`)
      }
      replaceText(dest, content)
      state = await dest.save()
    } catch (err) {
      dest.close()
      throw err
    }
    // The edits now live in the new file. A draft file stays on disk as recovery.
    const previous = this.unhook()
    if (previous) {
      await this.revertIfUnshown(previous)
      previous.close()
    }
    this.hold(dest)
    this.publish({ ...this.located(target), merging: false, loading: false, error: null })
    this.writeRecord(target)
    return { path: state.path, dirty: dest.state().dirty }
  }

  /** A rename moved the bound file (or a directory above it): the buffer
   *  identity moves with it, carrying unsaved edits. */
  private followMove(from: string, to: string): Promise<void> {
    return this.exclusive(async () => {
      const bound = this.boundPath
      const target = bound ? movedPath(bound, from, to) : undefined
      if (this.disposed || !bound || !target) return
      const previous = this.unhook()
      if (!previous) {
        await this.bind(target)
        this.writeRecord(target)
        return
      }
      const text = previous.text.toString()
      const wasDirty = previous.state().dirty
      let next: BufferHandle
      try {
        next = await this.deps.buffers.open(target)
      } catch (err) {
        previous.close()
        this.boundPath = target
        this.publish({ ...this.located(target), loading: false, error: message(err, 'Could not open the moved file.') })
        this.writeRecord(target)
        return
      }
      // The first editor to follow carries the edits; later ones find them there.
      if (wasDirty && !next.state().dirty) replaceText(next, text)
      // The old path is gone: settle its buffer so it is released.
      await previous.resolveConflict('reload').catch(() => {})
      previous.close()
      if (this.disposed) {
        next.close()
        return
      }
      this.hold(next)
      this.publish({ ...this.located(target), loading: false, error: null })
      this.writeRecord(target)
    })
  }

  protected override recordChanged(): void {
    const file = filePathOf(this.record)
    if (!file || (this.boundPath && pathKey(file) === pathKey(this.boundPath))) return
    // Records are state: follow a file changed elsewhere (undo, another client).
    void this.exclusive(async () => {
      const latest = filePathOf(this.record)
      if (this.disposed || !latest || (this.boundPath && pathKey(latest) === pathKey(this.boundPath))) return
      await this.bind(latest)
    })
  }

  protected override release(reason: DisposeReason, discard: boolean): void {
    this.offMoved?.()
    const handle = this.unhook()
    if (!handle) return
    if (reason === 'removed' && discard) {
      void this.revertIfUnshown(handle).finally(() => handle.close())
    } else {
      handle.close()
    }
  }
}
