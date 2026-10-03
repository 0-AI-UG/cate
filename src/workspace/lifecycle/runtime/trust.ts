// The trust gate (9.2): one decision per workspace in `<data>/trust.json`.
// Until trusted, the runtime runs no process and applies nothing from
// `<project>/.cate/`; every module asks this gate.

import { RpcError } from '@kernel/rpc/contract'
import { createJsonStateFile } from '@kernel/state/node'
import type { Trust, TrustState } from '../contract'

export interface TrustGate extends Trust {
  state(): TrustState
  set(trusted: boolean): TrustState
  onChange(listener: (state: TrustState) => void): () => void
  flush(): Promise<void>
  dispose(): void
}

export interface TrustGateOptions {
  /** `dataPaths(dir).trust`. */
  file: string
  /** `cate serve` trusts the workspace it serves. */
  trustOnStart?: boolean
  now?: () => Date
  debounceMs?: number
}

const UNDECIDED: TrustState = { trusted: false, decidedAt: null }

function normalizeTrust(parsed: unknown): TrustState {
  if (!parsed || typeof parsed !== 'object') return UNDECIDED
  const { trusted, decidedAt } = parsed as Record<string, unknown>
  return { trusted: trusted === true, decidedAt: typeof decidedAt === 'string' ? decidedAt : null }
}

export function createTrustGate(options: TrustGateOptions): TrustGate {
  const now = options.now ?? (() => new Date())
  const file = createJsonStateFile<TrustState>({
    file: options.file,
    defaults: UNDECIDED,
    normalize: normalizeTrust,
    debounceMs: options.debounceMs,
  })
  const listeners = new Set<(state: TrustState) => void>()

  const set = (trusted: boolean): TrustState => {
    const next: TrustState = { trusted, decidedAt: now().toISOString() }
    const changed = file.get().trusted !== trusted
    file.set(next)
    if (changed) for (const listener of [...listeners]) listener(next)
    return next
  }

  if (options.trustOnStart && !file.get().trusted) set(true)

  return {
    isTrusted: () => file.get().trusted,
    requireTrusted() {
      if (!file.get().trusted) throw new RpcError('untrusted', 'This workspace is not trusted')
    },
    state: () => file.get(),
    set,
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    flush: () => file.flush(),
    dispose() {
      listeners.clear()
      file.dispose()
    },
  }
}
