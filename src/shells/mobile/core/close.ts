// Mobile views register the same close guards the shared host runs for
// tabs and canvas descendants. The person's answer travels as `discard`.
import { registerPanelCloseGuard, type CloseGuard } from '@client/host'
import { clientUi } from '@kernel/interaction'
import type { TerminalSnapshot } from '@panels/terminal/contract'

export const terminalCloseGuard: CloseGuard = async ({ record, session }) => {
  if (!session) return false
  const snapshot = await new Promise<TerminalSnapshot | null>((resolve) => {
    const current = () => (session.getSnapshot()?.snapshot as TerminalSnapshot | undefined) ?? null
    if (current()) { resolve(current()); return }
    const timer = setTimeout(() => { off(); resolve(null) }, 2000)
    const off = session.subscribe(() => {
      const value = current()
      if (!value) return
      clearTimeout(timer)
      off()
      resolve(value)
    })
  })
  if (!snapshot) return false
  if (snapshot.status !== 'running' || snapshot.activity.type !== 'running') return true
  const process = snapshot.activity.processName || 'A program'
  return await clientUi().confirm(`${process} is running in ${record.title}. Closing this terminal will stop it. Close anyway?`) ? 'discard' : false
}

export function installMobileCloseGuards(): () => void {
  return registerPanelCloseGuard('terminal', terminalCloseGuard)
}
