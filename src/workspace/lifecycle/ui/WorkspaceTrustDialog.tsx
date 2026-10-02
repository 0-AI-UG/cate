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
// The session lives in the runtime's data, not the project, so a project
// cannot supply a layout that starts processes (GHSA-8769-jp52-985f). What it
// still controls: its git config and hooks, `.cate/skills.json`, and files
// that shells and agents run when started in it.

import { useState, useSyncExternalStore } from 'react'
import { ShieldAlert as ShieldWarning } from 'lucide-react'
import { Modal, Spinner, btn, errorMessage } from '@kernel/ui'
import { trustStore as defaultStore, type TrustStore } from './trustStore'

export function WorkspaceTrustDialog({ store = defaultStore }: { store?: TrustStore }): JSX.Element | null {
  const prompt = useSyncExternalStore(store.subscribe, store.current)
  const [busyChoice, setBusyChoice] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = busyChoice !== null

  if (!prompt) return null

  const answer = (trusted: boolean): void => {
    setBusyChoice(trusted)
    setError(null)
    store.answer(trusted).then(
      () => setBusyChoice(null),
      (err: unknown) => {
        setError(errorMessage(err, 'Could not trust this project.'))
        setBusyChoice(null)
      },
    )
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
        Trusting lets Cate run terminals, agents and git in this folder and apply the skills
        it ships in <code className="font-mono text-[12px]">.cate/</code>. A project's git config
        and files can run code on your machine through them.
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

      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}

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
          {busyChoice === false ? 'Closing' : 'Don\'t open'}
        </button>
        <button
          type="button"
          className={btn.primary}
          onClick={() => answer(true)}
          disabled={busy}
        >
          {busyChoice === true && <Spinner size={13} />}
          {busyChoice === true ? 'Opening' : 'Trust and open'}
        </button>
      </div>
    </Modal>
  )
}
