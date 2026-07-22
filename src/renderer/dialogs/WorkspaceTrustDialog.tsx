// =============================================================================
// WorkspaceTrustDialog — shown when a project's saved layout asked to open
// panels Cate withheld because the project isn't trusted.
//
// The safe outcome is the DEFAULT: the passive layout is already on screen, and
// every way out of this dialog except "Trust and restore" leaves it that way.
// So Escape and the backdrop dismiss freely (this is not a decision we force),
// but neither grants trust. The notice returns next time the project is opened
// until the user explicitly trusts it.
//
// "Open restricted" is the secondary action rather than a cancel, because the
// honest framing is that the user is choosing between two working states, not
// aborting an operation.
//
// See sessionTrustFilter.ts for what gets withheld and why (GHSA-8769-jp52-985f).
// =============================================================================

import { useState } from 'react'
import { ShieldWarning } from '@phosphor-icons/react'
import { Modal, btn } from '../ui/Modal'
import { useWorkspaceTrustStore } from '../stores/workspaceTrustStore'
import { describeWithheld } from '../lib/workspace/sessionTrustFilter'
import { trustProjectAndReload } from '../lib/workspace/projectTrustGate'
import log from '../lib/logger'

interface Props {
  workspaceId: string
}

export function WorkspaceTrustDialog({ workspaceId }: Props): JSX.Element | null {
  const notice = useWorkspaceTrustStore((s) => s.withheld[workspaceId])
  const clearWithheld = useWorkspaceTrustStore((s) => s.clearWithheld)
  const [restoring, setRestoring] = useState(false)

  if (!notice) return null

  const summary = describeWithheld(notice.summary)

  const onTrust = async (): Promise<void> => {
    setRestoring(true)
    try {
      await trustProjectAndReload(workspaceId, notice.locator)
    } catch (err) {
      log.warn('[trust] restore-after-trust failed: %s', err)
      setRestoring(false)
    }
  }

  return (
    <Modal
      onClose={() => clearWithheld(workspaceId)}
      width={420}
      icon={<ShieldWarning size={16} weight="fill" className="text-amber-400" />}
      title="Do you trust this project?"
      dismissable={!restoring}
      bodyClassName="px-5 py-4"
    >
      <p className="text-[13px] leading-relaxed text-secondary">
        This project&apos;s saved layout asked to open {summary}. Those can run code on your
        machine, so Cate left them closed.
      </p>

      {/* The path is the one thing that tells the user WHICH project is asking,
          which matters when a layout restores on launch without them opening
          anything. Breaks anywhere so a long path can't blow out the card. */}
      <div className="mt-3 px-2.5 py-2 rounded-md bg-surface-5 border border-subtle">
        <span className="text-[12px] text-muted font-mono break-all">{notice.locator}</span>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Only trust projects you would run code from. You can keep working either way, and this is
        remembered per project.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        {/* The SAFE action takes initial focus deliberately: with focus on the
            trust button, a stray Enter would grant a security decision the user
            never read. */}
        <button
          type="button"
          className={btn.secondary}
          onClick={() => clearWithheld(workspaceId)}
          disabled={restoring}
          autoFocus
        >
          Open restricted
        </button>
        <button
          type="button"
          className={btn.primary}
          onClick={() => void onTrust()}
          disabled={restoring}
        >
          {restoring ? 'Restoring…' : 'Trust and restore'}
        </button>
      </div>
    </Modal>
  )
}
