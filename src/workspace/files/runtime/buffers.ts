// Open buffers (architecture 9.4, 13.3): one Yjs document per open file, shared
// by every editor showing it. Loaded on first open, saved against the hash it
// was loaded from, persisted to `<data>/buffers/` while it has unsaved edits,
// dropped when nobody holds it and it is clean. The watcher reloads a clean
// buffer and marks a dirty one conflicting.

import fs from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import { RpcError } from '@kernel/rpc/contract'
import type { KeyedLock } from '@kernel/state/contract'
import { writeFileAtomic } from '@kernel/state/node'
import type { Logger } from '@kernel/log/contract'
import {
  BUFFER_TEXT,
  contentHash,
  pathKey,
  textDelta,
  type BufferConflict,
  type BufferResolution,
  type BufferState,
  type FsChangeType,
} from '../contract'
import type { PathScope } from './pathScope'
import { threeWayMerge } from './threeWayMerge'
import { readBytesOrNull, writeAtomic } from './fileOps'

export interface BufferHandle {
  readonly path: string
  readonly doc: Y.Doc
  readonly text: Y.Text
  state(): BufferState
  /** State changes (dirty, conflict, base). */
  subscribe(listener: (state: BufferState) => void): () => void
  /** Every Yjs update with its origin. */
  onUpdate(listener: (update: Uint8Array, origin: unknown) => void): () => void
  applyUpdate(update: Uint8Array, origin?: unknown): void
  save(): Promise<BufferState>
  resolveConflict(resolution: BufferResolution): Promise<BufferState>
  /** Releases this handle; the buffer is dropped once no handle holds it and
   *  it is clean. */
  close(): void
}

export interface BufferService {
  open(path: string): Promise<BufferHandle>
  save(path: string): Promise<BufferState>
  resolveConflict(path: string, resolution: BufferResolution): Promise<BufferState>
  /** Loads every persisted unsaved buffer; returns their paths. */
  restore(): Promise<string[]>
  /** Paths of the buffers in memory. */
  openPaths(): string[]
  /** Writes pending persistence now. */
  flush(): Promise<void>
  dispose(): Promise<void>
}

export interface BufferDeps {
  paths: PathScope
  /** Watches a directory; the files runtime passes its watch pool. */
  watch: (dir: string, onChange: (changedPath: string, type: FsChangeType) => void) => () => void
  /** `<data>/buffers`. */
  dir: string
  /** The per-path write queue shared with the file capability. */
  lock: KeyedLock
  log?: Logger
  /** Debounce of the unsaved-buffer file. */
  persistDelayMs?: number
  /** Coalesces watcher bursts (an atomic save is a delete plus a create). */
  settleMs?: number
}

interface PersistedMeta {
  path: string
  baseHash: string | null
  baseText: string
}

const decoder = new TextDecoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const BOM = '\uFEFF'
const encoder = new TextEncoder()
/** Origin of changes the runtime makes itself (reload, merge). */
const RUNTIME_ORIGIN = Symbol('buffer-runtime')

/** `[u32 meta length][meta JSON][Yjs update]`. */
function encodePersisted(meta: PersistedMeta, update: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + json.length + update.length)
  new DataView(out.buffer).setUint32(0, json.length)
  out.set(json, 4)
  out.set(update, 4 + json.length)
  return out
}

function decodePersisted(bytes: Uint8Array): { meta: PersistedMeta; update: Uint8Array } | null {
  if (bytes.length < 4) return null
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (4 + len > bytes.length) return null
  try {
    const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + len))) as PersistedMeta
    if (typeof meta?.path !== 'string' || typeof meta.baseText !== 'string') return null
    if (meta.baseHash !== null && typeof meta.baseHash !== 'string') return null
    return { meta, update: bytes.subarray(4 + len) }
  } catch {
    return null
  }
}

function sameState(a: BufferState, b: BufferState): boolean {
  return a.baseHash === b.baseHash && a.dirty === b.dirty && a.conflict === b.conflict
}

class OpenBuffer {
  readonly doc = new Y.Doc()
  readonly text = this.doc.getText(BUFFER_TEXT)
  baseText = ''
  baseHash: string | null = null
  conflict: BufferConflict | null = null
  dirty = false
  refs = 0
  ready: Promise<void> = Promise.resolve()
  dropped = false
  /** The file starts with a UTF-8 byte order mark; saves write it back. */
  private bom = false
  /** The file is not UTF-8: it shows as decoded but never saves. */
  private readOnly = false
  private stopWatch: (() => void) | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persisted = false
  private published: BufferState
  readonly stateListeners = new Set<(state: BufferState) => void>()
  readonly updateListeners = new Set<(update: Uint8Array, origin: unknown) => void>()

  constructor(readonly path: string, readonly file: string, private readonly svc: BufferServiceImpl) {
    this.published = this.state()
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.refresh()
      this.schedulePersist()
      for (const listener of [...this.updateListeners]) {
        try { listener(update, origin) } catch { /* isolate listeners */ }
      }
    })
  }

  state(): BufferState {
    return { path: this.path, baseHash: this.baseHash, dirty: this.dirty, conflict: this.conflict, ...(this.readOnly ? { readOnly: true as const } : {}) }
  }

  current(): string {
    return this.text.toString()
  }

  /** Recomputes `dirty` and tells listeners when the state moved. */
  refresh(): void {
    this.dirty = this.current() !== this.baseText
    const next = this.state()
    if (sameState(next, this.published)) return
    this.published = next
    for (const listener of [...this.stateListeners]) {
      try { listener(next) } catch { /* isolate listeners */ }
    }
  }

  replaceText(next: string): void {
    const delta = textDelta(this.current(), next)
    if (!delta) return
    this.doc.transact(() => {
      if (delta.remove) this.text.delete(delta.index, delta.remove)
      if (delta.insert) this.text.insert(delta.index, delta.insert)
    }, RUNTIME_ORIGIN)
  }

  setBase(text: string, hash: string | null): void {
    this.baseText = text
    this.baseHash = hash
  }

  /** The text of the file's bytes; notes a byte order mark and bytes that
   *  are not UTF-8. */
  private decodeDisk(bytes: Uint8Array): string {
    try {
      const text = strictDecoder.decode(bytes)
      this.readOnly = false
      this.bom = text.startsWith(BOM)
      return this.bom ? text.slice(1) : text
    } catch {
      this.readOnly = true
      this.bom = false
      return decoder.decode(bytes)
    }
  }

  async load(): Promise<void> {
    const onDisk = await readBytesOrNull(this.path)
    if (onDisk) this.decodeDisk(onDisk)
    const saved = await readBytesOrNull(this.file)
    const persisted = saved ? decodePersisted(saved) : null
    if (persisted && pathKey(persisted.meta.path) === pathKey(this.path)) {
      Y.applyUpdate(this.doc, persisted.update, RUNTIME_ORIGIN)
      this.setBase(persisted.meta.baseText, persisted.meta.baseHash)
      this.persisted = true
      await this.checkDisk()
    } else {
      const text = onDisk ? this.decodeDisk(onDisk) : ''
      this.setBase(text, onDisk ? contentHash(onDisk) : null)
      this.replaceText(text)
    }
    this.refresh()
    await this.watchDisk()
  }

  /** Follows the file on disk. A file whose folder does not exist yet (an
   *  untitled draft) is watched once a save creates the folder. */
  private async watchDisk(): Promise<void> {
    if (this.stopWatch || this.dropped) return
    const dir = path.dirname(this.path)
    const exists = await fs.stat(dir).then((s) => s.isDirectory(), () => false)
    if (!exists || this.stopWatch || this.dropped) return
    this.stopWatch = this.svc.deps.watch(dir, (changed, type) => {
      if (pathKey(changed) === pathKey(this.path)) this.onExternal(type)
    })
  }

  private onExternal(_type: FsChangeType): void {
    if (this.settleTimer) return
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      void this.svc.deps.lock.run(pathKey(this.path), () => this.checkDisk())
        .then(() => this.afterChange())
        .catch((err) => this.svc.deps.log?.warn('buffer reload failed', this.path, err))
    }, this.svc.deps.settleMs ?? 50)
  }

  /** Brings the buffer in line with the disk: nothing when the disk still
   *  matches the base, a reload when clean, a conflict when dirty. */
  async checkDisk(): Promise<void> {
    if (this.dropped) return
    const bytes = await readBytesOrNull(this.path)
    const hash = bytes ? contentHash(bytes) : null
    if (hash === this.baseHash) {
      this.conflict = null
    } else if (!bytes) {
      this.conflict = { kind: 'deleted', baseText: this.baseText }
    } else {
      const diskText = this.decodeDisk(bytes)
      if (this.current() === diskText || this.current() === this.baseText) {
        this.setBase(diskText, hash)
        this.replaceText(diskText)
        this.conflict = null
      } else {
        this.conflict = { kind: 'changed', baseText: this.baseText, diskText, diskHash: hash! }
      }
    }
    this.refresh()
  }

  async save(): Promise<BufferState> {
    return this.svc.deps.lock.run(pathKey(this.path), async () => {
      const disk = await readBytesOrNull(this.path)
      const diskHash = disk ? contentHash(disk) : null
      if (diskHash !== this.baseHash) {
        await this.checkDisk()
        throw new RpcError('conflict', 'The file changed on disk since it was loaded', { hash: diskHash })
      }
      if (this.readOnly) throw new RpcError('rejected', 'The file is not UTF-8 text; it opens read-only')
      const content = this.current()
      const written = this.bom ? BOM + content : content
      await writeAtomic(await this.svc.deps.paths.forCreation(this.path), written)
      this.setBase(content, contentHash(written))
      this.conflict = null
      this.refresh()
      await this.watchDisk()
      return this.state()
    }).finally(() => this.afterChange())
  }

  async resolve(resolution: BufferResolution): Promise<BufferState> {
    return this.svc.deps.lock.run(pathKey(this.path), async () => {
      const disk = await readBytesOrNull(this.path)
      const diskText = disk ? this.decodeDisk(disk) : null
      const diskHash = disk ? contentHash(disk) : null
      if (resolution === 'reload') {
        this.setBase(diskText ?? '', diskHash)
        this.replaceText(diskText ?? '')
      } else if (resolution === 'merge' && diskText !== null) {
        const { merged } = threeWayMerge(this.baseText, this.current(), diskText, { mine: 'Your changes', theirs: 'On disk' })
        this.setBase(diskText, diskHash)
        this.replaceText(merged)
      } else {
        this.setBase(diskText ?? '', diskHash)
      }
      this.conflict = null
      this.refresh()
      return this.state()
    }).finally(() => this.afterChange())
  }

  private afterChange(): void {
    this.schedulePersist(0)
    this.svc.maybeDrop(this)
  }

  needsPersist(): boolean {
    return this.dirty || this.conflict !== null
  }

  schedulePersist(delay = this.svc.deps.persistDelayMs ?? 300): void {
    if (this.dropped) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist().catch((err) => this.svc.deps.log?.warn('buffer persist failed', this.path, err))
    }, delay)
  }

  async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (this.needsPersist()) {
      const meta: PersistedMeta = { path: this.path, baseHash: this.baseHash, baseText: this.baseText }
      await writeFileAtomic(this.file, encodePersisted(meta, Y.encodeStateAsUpdate(this.doc)), { mode: 0o600 })
      this.persisted = true
    } else if (this.persisted) {
      await fs.rm(this.file, { force: true })
      this.persisted = false
    }
  }

  destroy(): void {
    this.dropped = true
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.stopWatch?.()
    this.stopWatch = null
    this.stateListeners.clear()
    this.updateListeners.clear()
    this.doc.destroy()
  }

  handle(): BufferHandle {
    let closed = false
    this.refs++
    return {
      path: this.path,
      doc: this.doc,
      text: this.text,
      state: () => this.state(),
      subscribe: (listener) => {
        this.stateListeners.add(listener)
        return () => { this.stateListeners.delete(listener) }
      },
      onUpdate: (listener) => {
        this.updateListeners.add(listener)
        return () => { this.updateListeners.delete(listener) }
      },
      applyUpdate: (update, origin) => {
        if (closed) throw new RpcError('gone', 'Buffer handle is closed')
        Y.applyUpdate(this.doc, update, origin)
      },
      save: () => this.save(),
      resolveConflict: (resolution) => this.resolve(resolution),
      close: () => {
        if (closed) return
        closed = true
        this.refs--
        this.svc.maybeDrop(this)
      },
    }
  }
}

class BufferServiceImpl implements BufferService {
  private readonly buffers = new Map<string, OpenBuffer>()

  constructor(readonly deps: BufferDeps) {}

  private fileFor(p: string): string {
    return path.join(this.deps.dir, `${contentHash(pathKey(p)).slice(0, 32)}.bin`)
  }

  private async acquire(p: string, safe?: string): Promise<OpenBuffer> {
    safe ??= await this.deps.paths.strict(p)
    const key = pathKey(safe)
    let buffer = this.buffers.get(key)
    if (!buffer) {
      const created = new OpenBuffer(safe, this.fileFor(safe), this)
      created.ready = created.load().catch((err) => {
        if (this.buffers.get(key) === created) this.buffers.delete(key)
        created.destroy()
        throw err
      })
      this.buffers.set(key, created)
      buffer = created
    }
    await buffer.ready
    return buffer
  }

  async open(p: string): Promise<BufferHandle> {
    for (;;) {
      const buffer = await this.acquire(p)
      // A buffer dropped while this open waited is gone; load it again.
      if (!buffer.dropped) return buffer.handle()
    }
  }

  private async existing(p: string): Promise<OpenBuffer> {
    const buffer = this.buffers.get(pathKey(await this.deps.paths.strict(p)))
    if (!buffer) throw new RpcError('gone', `No open buffer for ${p}`)
    await buffer.ready
    return buffer
  }

  async save(p: string): Promise<BufferState> {
    return (await this.existing(p)).save()
  }

  async resolveConflict(p: string, resolution: BufferResolution): Promise<BufferState> {
    return (await this.existing(p)).resolve(resolution)
  }

  maybeDrop(buffer: OpenBuffer): void {
    if (buffer.dropped || buffer.refs > 0 || buffer.needsPersist()) return
    const key = pathKey(buffer.path)
    if (this.buffers.get(key) === buffer) this.buffers.delete(key)
    void buffer.persist().catch(() => {}).finally(() => buffer.destroy())
    buffer.dropped = true
  }

  async restore(): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.deps.dir)
    } catch {
      return []
    }
    const restored: string[] = []
    for (const name of names) {
      if (!name.endsWith('.bin')) continue
      const file = path.join(this.deps.dir, name)
      const bytes = await readBytesOrNull(file)
      const persisted = bytes ? decodePersisted(bytes) : null
      if (!persisted) continue
      try {
        const safe = await this.deps.paths.strict(persisted.meta.path)
        if (this.fileFor(safe) !== file) continue
        const buffer = await this.acquire(safe, safe)
        restored.push(buffer.path)
        this.maybeDrop(buffer)
      } catch (err) {
        this.deps.log?.warn('could not restore buffer', persisted.meta.path, err)
      }
    }
    return restored
  }

  openPaths(): string[] {
    return [...this.buffers.values()].map((b) => b.path)
  }

  async flush(): Promise<void> {
    await Promise.all([...this.buffers.values()].map((b) => b.persist()))
  }

  async dispose(): Promise<void> {
    await this.flush().catch(() => {})
    for (const buffer of this.buffers.values()) buffer.destroy()
    this.buffers.clear()
  }
}

export function createBufferService(deps: BufferDeps): BufferService {
  return new BufferServiceImpl(deps)
}
