// The client side of workspace trust (9.2): one decision per workspace, held
// by its runtime. Opening an untrusted workspace asks the person once; the
// answer is `workspace.setTrust` and applies for everyone. Declining is not
// remembered: the caller just does not keep the workspace open.
//
// Questions queue: only the head is on screen, so a launch that reopens
// several untrusted workspaces asks about them one at a time.

import { tryRuntimeFor } from '@kernel/rpc/client'
import type { CapabilityProxy } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import type { workspaceCapability } from '../contract'

const log = createLogger('trust')

export type TrustApi = Pick<CapabilityProxy<typeof workspaceCapability>, 'getTrust' | 'setTrust'>

export interface TrustPrompt {
  workspaceId: string
  /** What the dialog shows so the person knows which workspace asks: its
   *  root path (or its name when the root is unknown). */
  label: string
}

export interface TrustStore {
  /** Resolves true when the workspace may stay open: already trusted, or the
   *  person just trusted it. Resolves false when they declined. */
  ensureTrusted(workspaceId: string, label: string): Promise<boolean>
  /** The dialog's answer to the question at the head of the queue. Rejects,
   *  leaving the question open, when the runtime did not store the trust. */
  answer(trusted: boolean): Promise<void>
  /** The question on screen, or null. */
  current(): TrustPrompt | null
  subscribe(listener: () => void): () => void
}

interface Pending extends TrustPrompt {
  resolve(trusted: boolean): void
}

export function createTrustStore(api: (workspaceId: string) => TrustApi | null): TrustStore {
  let queue: Pending[] = []
  const listeners = new Set<() => void>()
  const notify = () => { for (const l of [...listeners]) l() }

  const ask = (workspaceId: string, label: string) => new Promise<boolean>((resolve) => {
    // Two open paths racing on one workspace both ride the single question:
    // answering resolves every queued entry for it at once.
    queue = [...queue, { workspaceId, label, resolve }]
    notify()
  })

  return {
    async ensureTrusted(workspaceId, label) {
      if (!workspaceId) return false
      const trust = api(workspaceId)
      try {
        if (trust && (await trust.getTrust()).trusted) return true
      } catch (err) {
        // Fail closed: an unreadable trust state asks rather than opens.
        log.warn('could not read trust for %s: %s', label, err)
      }
      return ask(workspaceId, label)
    },
    async answer(trusted) {
      const head = queue[0]
      if (!head) return
      if (trusted) {
        // Opening on a trust the runtime does not hold would leave every
        // terminal and git call failing with `untrusted`.
        const trust = api(head.workspaceId)
        if (!trust) throw new Error('The workspace runtime is not connected.')
        try {
          if (!(await trust.setTrust({ trusted: true })).trusted) throw new Error('The workspace runtime did not store the trust.')
        } catch (err) {
          log.warn('could not store trust for %s: %s', head.label, err)
          throw err
        }
      }
      const answered = queue.filter((p) => p.workspaceId === head.workspaceId)
      queue = queue.filter((p) => p.workspaceId !== head.workspaceId)
      notify()
      for (const prompt of answered) prompt.resolve(trusted)
    },
    // The same object until the queue moves, as useSyncExternalStore needs.
    current: () => queue[0] ?? null,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** The client's trust store over the runtime slot. */
export const trustStore: TrustStore = createTrustStore((workspaceId) => tryRuntimeFor(workspaceId)?.workspace ?? null)
