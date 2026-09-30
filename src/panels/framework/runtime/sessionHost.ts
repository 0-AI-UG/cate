// The session host (architecture 11.1, 11.2 rule 7): one session per
// document panel. It follows the document: a panel added gets a session that
// starts, a removed one is disposed (with its state file), a replaced one is
// swapped under the same id, and a changed record is passed on. Ops for a
// panel run one after another and fail with `gone` once it is removed.

import type { ApiSessionContext } from '@kernel/api/contract'
import { createLogger, type Logger } from '@kernel/log/contract'
import { RpcError } from '@kernel/rpc/contract'
import { KeyedLock } from '@kernel/state/contract'
import { opChanges, type PanelId, type PanelRecord } from '@workspace/document/contract'
import type { AppliedEvent, DocumentService } from '@workspace/document/runtime'
import type { OpContext, PanelSession, SessionKit, SessionSubscriber, SurfaceCallOptions } from './PanelSession'
import type { PanelRegistry } from './registry'
import { createSessionFileStore, type SessionFileStore } from './sessionStore'

export interface SessionHostDeps {
  document: DocumentService
  registry: PanelRegistry
  /** Page operations on the driving client (the surface broker). */
  surfaces: { request(panelId: PanelId, op: string, args: unknown, options?: SurfaceCallOptions): Promise<unknown> }
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
  input(panelId: PanelId, bytes: Uint8Array, ctx: OpContext): void
  subscribe(panelId: PanelId, subscriber: SessionSubscriber): () => void
  /** The `ApiSessionHost` of the kernel/api router. */
  handleApi(panelId: PanelId, method: string, args: Record<string, unknown>, ctx: ApiSessionContext): Promise<unknown>
  /** Asks each session before a close; `dirty` unless `discard`. */
  prepareClose(panelIds: readonly PanelId[], options: { discard: boolean }): Promise<void>
  /** Flushes state files and disposes every session (daemon stop). */
  dispose(): void
}

interface Entry {
  session: PanelSession
  store: SessionFileStore
  started: Promise<void>
}

const gone = (panelId: PanelId) => new RpcError('gone', `panel ${panelId} is gone`)

export function createSessionHost(deps: SessionHostDeps): SessionHost {
  const log = deps.log ?? createLogger('sessions')
  const entries = new Map<PanelId, Entry>()
  const lock = new KeyedLock()
  let disposed = false

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
      surface: (op, args, options) => deps.surfaces.request(record.id, op, args, options),
      session: (panelId) => entries.get(panelId)?.session,
    }
    const session = new registered.session(kit, record)
    const started = Promise.resolve()
      .then(() => (session.isDisposed ? undefined : session.start()))
      .catch((err) => log.error('panel %s (%s) failed to start: %O', record.id, record.type, err))
    entries.set(record.id, { session, store, started })
  }

  const drop = (panelId: PanelId, reason: 'removed' | 'replaced') => {
    const entry = entries.get(panelId)
    if (!entry) return
    entries.delete(panelId)
    entry.store.remove()
    try { entry.session.dispose(reason) } catch (err) { log.error('disposing panel %s failed: %O', panelId, err) }
  }

  const follow = ({ op, before, doc }: AppliedEvent) => {
    const replaced = new Set<PanelId>()
    for (const change of opChanges(op)) if (change.kind === 'replacePanel') replaced.add(change.record.id)
    for (const id of Object.keys(before.panels)) if (!doc.panels[id]) drop(id, 'removed')
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
    input(panelId, bytes, ctx) {
      entries.get(panelId)?.session.input(bytes, ctx)
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
    async prepareClose(panelIds, options) {
      for (const panelId of panelIds) await entries.get(panelId)?.session.prepareClose(options)
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
