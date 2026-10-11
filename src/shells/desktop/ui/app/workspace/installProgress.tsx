// How far the runtime installs the shell runs are (this device's, or one on
// a machine over SSH or WSL), as a bar with what happens and how many MB:
// the connecting cover and the folder dialog of a machine show it.

import { useSyncExternalStore } from 'react'
import { ProgressBar } from '../../kernel/interaction'
import { machineKey, type RuntimeInstallProgress } from '@runtime/daemon/contract'
import type { WorkspaceEntry } from '@client/workspaces'
import { desktopPort, type InstallProgressEvent } from '../desktop'

const current = new Map<string, RuntimeInstallProgress>()
const listeners = new Set<() => void>()
let started = false

function apply(event: InstallProgressEvent): void {
  if (event.progress) current.set(event.target, event.progress)
  else current.delete(event.target)
  for (const listener of [...listeners]) listener()
}

/** Follows the shell's installs from the first use on; an install already
 *  running is asked for once. */
function start(): void {
  const port = desktopPort()
  if (started || !port) return
  started = true
  port.onInstallProgress(apply)
  port.installs().then((events) => {
    // Something heard meanwhile is newer.
    for (const event of events) if (!current.has(event.target)) apply(event)
  }, () => {})
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The install running for `target` (`local`, or a `machineKey`), if any. */
export function useInstallProgress(target: string | null): RuntimeInstallProgress | null {
  return useSyncExternalStore(subscribe, () => (target ? current.get(target) ?? null : null))
}

/** Which install a workspace's connection waits for; null for a paired one. */
export function installTargetOf(entry: WorkspaceEntry | undefined): string | null {
  if (entry?.kind === 'local') return 'local'
  if (entry?.kind === 'machine') return machineKey(entry.machine)
  return null
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1)

/** What the install does now, in words, how far (null: not known) and the
 *  figures. `where` names another machine; omitted for this device. */
export function describeInstall(progress: RuntimeInstallProgress, where?: string): { label: string; value: number | null; detail: string | null } {
  if (progress.phase === 'install') return { label: where ? `Installing the Cate runtime on ${where}` : 'Installing the Cate runtime', value: null, detail: null }
  const label = progress.phase === 'upload' ? `Sending the Cate runtime to ${where ?? 'the machine'}` : 'Downloading the Cate runtime'
  const { received, total } = progress
  return {
    label,
    value: total ? received / total : null,
    detail: total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`,
  }
}

export function InstallProgressView({ progress, where }: { progress: RuntimeInstallProgress; where?: string }): JSX.Element {
  const { label, value, detail } = describeInstall(progress, where)
  return (
    <div role="status" className="flex flex-col gap-1.5" data-install-progress={progress.phase}>
      <span className="text-[12px] text-secondary">{label}</span>
      <ProgressBar value={value} label={label} />
      {detail && <span className="text-[11px] text-muted tabular-nums">{detail}</span>}
    </div>
  )
}
