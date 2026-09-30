// The one question Cate asks before running anything from a workspace it has
// not been trusted with: do you trust it?
//
// There are exactly two answers. "Trust and open" trusts the workspace (for
// every client, 9.2). "Don't open" leaves it closed. Every exit that isn't the
// primary button means "don't open": Escape and the backdrop decline rather
// than dismiss, and the decline button holds focus so a stray Enter can't grant
// trust.
//
// Renders the head of the trust store's queue.
//
// See GHSA-8769-jp52-985f for what an untrusted project's layout could do.

import { useState, useSyncExternalStore } from 'react'
import { ShieldAlert as ShieldWarning } from 'lucide-react'
import { Modal, Spinner, btn } from '@kernel/ui'
import { trustStore as defaultStore, type TrustStore } from './trustStore'

export function WorkspaceTrustDialog({ store = defaultStore }: { store?: TrustStore }): JSX.Element | null {
  const prompt = useSyncExternalStore(store.subscribe, store.current)
  const [busyChoice, setBusyChoice] = useState<boolean | null>(null)
  const busy = busyChoice !== null

  if (!prompt) return null

  const answer = (trusted: boolean): void => {
    setBusyChoice(trusted)
    void store.answer(trusted).finally(() => setBusyChoice(null))
  }

  return (
    <Modal
      onClose={() => answer(false)}
      width={420}
      icon={<ShieldWarning size={16} className="text-amber-400" />}
      title="Do you trust this project?"
      dismissable={!busy}
      bodyClassName="px-5 py-4"
    >
      <p className="text-[13px] leading-relaxed text-secondary">
        Opening a project restores its saved layout, which can start terminals, agents and
        tools from that folder. Opening it can run its code on your machine.
      </p>

      {/* Which project is asking, which matters at launch when the person
          didn't open anything themselves. Breaks anywhere so a long path
          can't blow out the card. */}
      <div className="mt-3 px-2.5 py-2 rounded-md bg-surface-5 border border-subtle">
        <span className="text-[12px] text-muted font-mono break-all">{prompt.label}</span>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Only open projects you would run code from. This is remembered per project.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        {/* The safe action takes initial focus: with focus on the trust
            button, a stray Enter would grant a decision the person never read. */}
        <button
          type="button"
          className={btn.secondary}
          onClick={() => answer(false)}
          disabled={busy}
          autoFocus
        >
          {busyChoice === false && <Spinner size={13} />}
          {busyChoice === false ? 'Closing…' : 'Don\'t open'}
        </button>
        <button
          type="button"
          className={btn.primary}
          onClick={() => answer(true)}
          disabled={busy}
        >
          {busyChoice === true && <Spinner size={13} />}
          {busyChoice === true ? 'Opening…' : 'Trust and open'}
        </button>
      </div>
    </Modal>
  )
}
