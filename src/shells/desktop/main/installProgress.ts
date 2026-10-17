// How far each runtime install main runs is (this device's, or one on a
// machine over SSH or WSL), for every window: sent as it moves (at most ten
// times a second, every change of step at once), and asked for by a window
// that opens in the middle of one.

import type { InstallProgressEvent } from '../contract'
import type { RuntimeInstallProgress } from '@runtime/daemon/contract'

const EVERY_MS = 100

export interface InstallProgressHub {
  /** null: the install ended. */
  report(target: string, progress: RuntimeInstallProgress | null): void
  snapshot(): InstallProgressEvent[]
}

export function createInstallProgress(send: (event: InstallProgressEvent) => void, now: () => number = Date.now): InstallProgressHub {
  const current = new Map<string, { progress: RuntimeInstallProgress; sentAt: number }>()
  return {
    report(target, progress) {
      const last = current.get(target)
      if (!progress) {
        if (!last) return
        current.delete(target)
        return send({ target, progress: null })
      }
      const at = now()
      const due = !last || last.progress.phase !== progress.phase || at - last.sentAt >= EVERY_MS
      current.set(target, { progress, sentAt: due ? at : last.sentAt })
      if (due) send({ target, progress })
    },
    snapshot: () => [...current].map(([target, { progress }]) => ({ target, progress })),
  }
}
