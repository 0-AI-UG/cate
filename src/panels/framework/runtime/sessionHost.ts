// The session host (architecture 11.1, 11.2 rule 7): one session per
// document panel. It follows the document: a panel added gets a session that
// starts, a removed one is disposed (its state file set aside under
// `sessions/removed/` for a day, so undoing the removal brings the state
// back), a replaced one is swapped under the same id, and a changed record is
// passed on. Ops for a panel run one after another and fail with `gone` once
// it is removed.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ApiSessionContext } from '@kernel/api/contract'
import { createLogger, type Logger } from '@kernel/log/contract'
import { RpcError } from '@kernel/rpc/contract'
import { KeyedLock } from '@kernel/state/contract'
import { opChanges, type PanelId, type PanelRecord } from '@workspace/document/contract'
import type { AppliedEvent, DocumentService } from '@workspace/document/runtime'
import type { OpContext, PanelSession, SessionKit, SessionSubscriber } from './PanelSession'
import type { SurfaceBroker } from './surfaces'
import type { PanelRegistry } from './registry'
import { createSessionFileStore, type SessionFileStore } from './sessionStore'

export interface SessionHostDeps {
  document: DocumentService
  registry: PanelRegistry
  /** Page operations on the driving client (the surface broker). */
  surfaces: Pick<SurfaceBroker, 'request'>
  /** `dataPaths(dir).session`. */
  sessionFile(panelId: PanelId): string
  log?: Logger
  persistDebounceMs?: number
}

export interface SessionHost {
  /** Creates and starts the sessions of every panel in the document; run
   *  once at daemon start. Resolves when every start settled. */
  restore(): Promise<void>
  session(panelId: PanelId): PanelSession | undefined
  /** Resolves once the panel's session finished `start()`. */
  started(panelId: PanelId): Promise<void>
  op(panelId: PanelId, op: unknown, ctx: OpContext): Promise<unknown>
  subscribe(panelId: PanelId, subscriber: SessionSubscriber): () => void
  /** The `ApiSessionHost` of the kernel/api router. */
  handleApi(panelId: PanelId, method: string, args: Record<string, unknown>, ctx: ApiSessionContext): Promise<unknown>
  /** Throws `RpcError('dirty')` when removing `removing` would lose a
   *  panel's work, apart from the panels in `discard` (the document's
   *  removal guard and `cate panel close`). */
  checkRemoval(removing: ReadonlySet<PanelId>, discard: ReadonlySet<PanelId>): void
  /** Flushes state files and disposes every session (daemon stop). */
  dispose(): void
}

interface Entry {
  session: PanelSession
  store: SessionFileStore
  started: Promise<void>
}

const gone = (panelId: PanelId) => new RpcError('gone', `panel ${panelId} is gone`)

/** How long the state of a removed panel is kept for an undo. */
const REMOVED_KEEP_MS = 24 * 60 * 60_000

export function createSessionHost(deps: SessionHostDeps): SessionHost {
  const log = deps.log ?? createLogger('sessions')
  const entries = new Map<PanelId, Entry>()
  const lock = new KeyedLock()
  // A dropped panel's state file until it is set aside; a session created
  // under the same id starts after it.
  const retiring = new Map<PanelId, Promise<void>>()
  let disposed = false

  const removedFile = (panelId: PanelId) => {
    const file = deps.sessionFile(panelId)
    return path.join(path.dirname(file), 'removed', path.basename(file))
  }

  /** Brings back the state a removed panel of this id left. */
  const bringBack = async (panelId: PanelId): Promise<void> => {
    await retiring.get(panelId)
    await fs.rename(removedFile(panelId), deps.sessionFile(panelId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') log.warn('restoring the state of panel %s failed: %s', panelId, err.message)
    })
  }

  const pruneRemoved = async (): Promise<void> => {
    const dir = path.dirname(removedFile('x'))
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const cutoff = Date.now() - REMOVED_KEEP_MS
    for (const name of names) {
      const file = path.join(dir, name)
      const stat = await fs.stat(file).catch(() => null)
      if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true })
    }
  }

  const create = (record: PanelRecord): void => {
    const registered = deps.registry.get(record.type)
    if (!registered) {
      log.warn('no panel type %s for panel %s', record.type, record.id)
      return
    }
    const store = createSessionFileStore(deps.sessionFile(record.id), log, deps.persistDebounceMs)
    const kit: SessionKit = {
      panelId: record.id,
      document: deps.document,
      store,
      log,
      surface: (op, args, options) => {
        const feature = registered.definition.surface?.ops[op]
        if (!feature) return Promise.reject(new RpcError('unsupported', `${record.type} has no page operation ${op}`))
        return deps.surfaces.request(record.id, op, args, { ...options, feature })
      },
    }
    const session = new registered.session(kit, record)
    const started = bringBack(record.id)
      .then(() => (session.isDisposed ? undefined : session.start()))
      .catch((err) => log.error('panel %s (%s) failed to start: %O', record.id, record.type, err))
    entries.set(record.id, { session, store, started })
  }

  const drop = (panelId: PanelId, reason: 'removed' | 'replaced', discard = false) => {
    const entry = entries.get(panelId)
    if (!entry) return
    entries.delete(panelId)
    const retired = entry.store.retire(reason === 'removed' ? removedFile(panelId) : null)
    retiring.set(panelId, retired)
    void retired.finally(() => { if (retiring.get(panelId) === retired) retiring.delete(panelId) })
    try { entry.session.dispose(reason, discard) } catch (err) { log.error('disposing panel %s failed: %O', panelId, err) }
  }

  const follow = ({ op, before, doc }: AppliedEvent) => {
    const replaced = new Set<PanelId>()
    const discarded = new Set<PanelId>()
    for (const change of opChanges(op)) {
      if (change.kind === 'replacePanel') replaced.add(change.record.id)
      if (change.kind === 'removePanels' || change.kind === 'closeWindow') for (const id of change.discard ?? []) discarded.add(id)
    }
    for (const id of Object.keys(before.panels)) if (!doc.panels[id]) drop(id, 'removed', discarded.has(id))
    for (const record of Object.values(doc.panels)) {
      const entry = entries.get(record.id)
      if (entry && (replaced.has(record.id) || entry.session.record.type !== record.type)) {
        drop(record.id, 'replaced')
        create(record)
      } else if (!entry) {
        create(record)
      } else if (entry.session.record !== record) {
        entry.session.updateRecord(record)
      }
    }
  }
  const offDocument = deps.document.subscribe(follow)

  const entryOf = (panelId: PanelId): Entry => {
    const entry = entries.get(panelId)
    if (!entry || disposed) throw gone(panelId)
    return entry
  }

  return {
    async restore() {
      await pruneRemoved()
      for (const record of Object.values(deps.document.get().panels)) if (!entries.has(record.id)) create(record)
      await Promise.all([...entries.values()].map((entry) => entry.started))
    },
    session: (panelId) => entries.get(panelId)?.session,
    started: (panelId) => entries.get(panelId)?.started ?? Promise.reject(gone(panelId)),
    async op(panelId, op, ctx) {
      entryOf(panelId)
      return lock.run(panelId, async () => {
        const entry = entryOf(panelId)
        await entry.started
        return entry.session.handleOp(op, ctx)
      })
    },
    subscribe(panelId, subscriber) {
      return entryOf(panelId).session.attach(subscriber)
    },
    async handleApi(panelId, method, args, ctx) {
      const entry = entryOf(panelId)
      await entry.started
      if (!entry.session.handleApi) throw new RpcError('unsupported', `${ctx.method} is not handled by this panel`)
      return entry.session.handleApi(method, args, ctx)
    },
    checkRemoval(removing, discard) {
      for (const panelId of removing) {
        if (discard.has(panelId)) continue
        const blocker = entries.get(panelId)?.session.closeBlocker(removing)
        if (blocker) throw blocker
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      offDocument()
      for (const [panelId, entry] of entries) {
        entry.store.flushSync()
        try { entry.session.dispose('shutdown') } catch (err) { log.error('disposing panel %s failed: %O', panelId, err) }
      }
      entries.clear()
    },
  }
}
