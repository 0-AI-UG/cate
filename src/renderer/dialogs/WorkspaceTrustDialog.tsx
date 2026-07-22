// =============================================================================
// WorkspaceTrustDialog — the one question Cate asks before opening a project it
// has never opened before: do you trust it?
//
// There are exactly two answers. "Trust and open" opens the project normally.
// "Don't open" leaves it closed — nothing from the folder is read, no panel is
// restored, no process is started. There is deliberately no third "open it but
// hold parts back" option: a half-restored layout is confusing to the user and
// was a whole subsystem to maintain.
//
// So every exit that isn't the primary button means "don't open": Escape and the
// backdrop decline rather than dismiss, and the decline button holds focus so a
// stray Enter can't grant trust. Trust is remembered per project (in userData,
// never in the project) so this is asked once.
//
// Renders the head of the trust store's queue, so a launch that needs to ask
// about several projects asks about them one at a time.
//
// See GHSA-8769-jp52-985f for what an untrusted project's layout could do.
// =============================================================================

import { useState } from 'react'
import { ShieldWarning } from '@phosphor-icons/react'
import { Modal, btn } from '../ui/Modal'
import { useWorkspaceTrustStore } from '../stores/workspaceTrustStore'

export function WorkspaceTrustDialog(): JSX.Element | null {
  const locator = useWorkspaceTrustStore((s) => s.queue[0]?.locator)
  const answerTrustPrompt = useWorkspaceTrustStore((s) => s.answerTrustPrompt)
  const [busy, setBusy] = useState(false)

  if (!locator) return null

  const answer = (trusted: boolean): void => {
    setBusy(true)
    void answerTrustPrompt(trusted).finally(() => setBusy(false))
  }

  return (
    <Modal
      onClose={() => answer(false)}
      width={420}
      icon={<ShieldWarning size={16} weight="fill" className="text-amber-400" />}
      title="Do you trust this project?"
      dismissable={!busy}
      bodyClassName="px-5 py-4"
    >
      <p className="text-[13px] leading-relaxed text-secondary">
        Opening a project restores its saved layout, which can start terminals, agents and
        extensions from that folder — so opening it can run its code on your machine.
      </p>

      {/* The path is the one thing that tells the user WHICH project is asking,
          which matters at launch when they didn't open anything themselves.
          Breaks anywhere so a long path can't blow out the card. */}
      <div className="mt-3 px-2.5 py-2 rounded-md bg-surface-5 border border-subtle">
        <span className="text-[12px] text-muted font-mono break-all">{locator}</span>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Only open projects you would run code from. This is remembered per project.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        {/* The SAFE action takes initial focus deliberately: with focus on the
            trust button, a stray Enter would grant a security decision the user
            never read. */}
        <button
          type="button"
          className={btn.secondary}
          onClick={() => answer(false)}
          disabled={busy}
          autoFocus
        >
          Don&apos;t open
        </button>
        <button
          type="button"
          className={btn.primary}
          onClick={() => answer(true)}
          disabled={busy}
        >
          Trust and open
        </button>
      </div>
    </Modal>
  )
}
