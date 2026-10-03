// What stopping or updating a workspace runtime would end: its live terminals
// and the agents running a turn. Listed and confirmed in the view before
// `runtime.stop` or `runtime.update` is sent (7.4, 7.10).

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Spinner } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import type { RuntimeProxy } from '@kernel/rpc/contract'

export interface RunningItem {
  id: string
  label: string
}

export interface RunningWorkList {
  terminals: RunningItem[]
  agents: RunningItem[]
}

/** Asks the runtime what runs now. Panel titles come from `title`, when the
 *  caller knows them. */
export async function listRunningWork(
  runtime: RuntimeProxy,
  title: (panelId: string) => string | undefined = () => undefined,
): Promise<RunningWorkList> {
  const [terminals, busy] = await Promise.all([
    runtime.process.list().catch(() => []),
    runtime.agents.busy().catch(() => ({ panelIds: [] as string[] })),
  ])
  return {
    terminals: terminals
      .filter((t) => t.alive)
      .map((t) => ({
        id: t.id,
        label: (t.panelId && title(t.panelId)) || (t.activity.type === 'running' ? t.activity.processName : t.shell),
      })),
    agents: busy.panelIds.map((panelId) => ({ id: panelId, label: title(panelId) ?? 'Agent' })),
  }
}

export interface RunningWorkConfirmProps {
  runtime: RuntimeProxy
  /** "Stop runtime", "Update and restart". */
  actionLabel: string
  /** What happens, in one sentence. */
  consequence: string
  title?: (panelId: string) => string | undefined
  onConfirm: () => Promise<void>
  onCancel: () => void
}

/** Lists the running work and asks before acting on it. */
export function RunningWorkConfirm({ runtime, actionLabel, consequence, title, onConfirm, onCancel }: RunningWorkConfirmProps): JSX.Element {
  const [work, setWork] = useState<RunningWorkList | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void listRunningWork(runtime, title).then((w) => { if (!cancelled) setWork(w) })
    return () => { cancelled = true }
    // The list is read once when the question opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(errorMessage(err, 'The runtime did not answer.'))
      setBusy(false)
    }
  }

  const items = work ? [...work.terminals.map((t) => ({ ...t, kind: 'Terminal' })), ...work.agents.map((a) => ({ ...a, kind: 'Agent' }))] : []

  return (
    <div role="alertdialog" aria-label={actionLabel} className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface-2 p-3">
      <div className="flex items-start gap-2 text-[12px] text-secondary">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
        <span>{consequence}</span>
      </div>
      {!work ? (
        <Spinner size={14} />
      ) : items.length === 0 ? (
        <span className="text-[12px] text-muted">Nothing is running.</span>
      ) : (
        <ul className="flex flex-col gap-0.5 text-[12px] text-primary" aria-label="Running work">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="flex gap-2">
              <span className="text-muted w-16 shrink-0">{item.kind}</span>
              <span className="truncate">{item.label}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <span className="text-[12px] text-danger">{error}</span>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="h-7 px-3 rounded-md text-[12px] text-secondary hover:bg-hover">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy || !work}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-medium bg-red-500/90 text-white hover:bg-red-500 disabled:opacity-50"
        >
          {busy && <Spinner size={12} />}
          {busy ? 'Working' : actionLabel}
        </button>
      </div>
    </div>
  )
}
