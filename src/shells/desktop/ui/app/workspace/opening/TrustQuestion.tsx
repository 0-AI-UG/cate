// The one question Cate asks before running anything from a workspace it has
// not been trusted with: do you trust it?
//
// There are exactly two answers. "Trust and open" trusts the workspace (for
// every client, 9.2). "Don't open" leaves it closed. Every exit that isn't the
// primary button means "don't open": Escape and the backdrop decline rather
// than dismiss, and the decline button holds focus so a stray Enter can't grant
// trust.
//
// Renders the head of the trust store's queue: as a modal, or as a card in
// the place of the workspace it is about while that workspace's opening
// surface is on screen (WorkspaceGate claims it with `useTrustInPlace`), so
// the question takes the spot the opening status held.
//
// The session lives in the runtime's data, not the project, so a project
// cannot supply a layout that starts processes (GHSA-8769-jp52-985f). What it
// still controls: its git config and hooks, `.cate/skills.json`, and files
// that shells and agents run when started in it.

import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { ShieldAlert as ShieldWarning } from 'lucide-react'
import { Modal, ModalCard, btn, Spinner } from '../../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { trustStore as defaultStore, type TrustPrompt, type TrustStore } from '@client/workspaces'

const TITLE = 'Do you trust this workspace?'
const ICON = <ShieldWarning size={16} className="text-amber-400" />

/** Workspaces whose question shows in their place, not as the modal. */
const inPlace = new Map<string, number>()
const listeners = new Set<() => void>()
const subscribeInPlace = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const notifyInPlace = () => { for (const listener of [...listeners]) listener() }

/** While `active`, the question about `workspaceId` shows in its place
 *  (WorkspaceTrustCard) instead of as the modal. A layout effect: the modal
 *  never paints in the frame the card takes over. */
export function useTrustInPlace(workspaceId: string | null, active: boolean): void {
  useLayoutEffect(() => {
    if (!workspaceId || !active) return
    inPlace.set(workspaceId, (inPlace.get(workspaceId) ?? 0) + 1)
    notifyInPlace()
    return () => {
      const left = (inPlace.get(workspaceId) ?? 1) - 1
      if (left > 0) inPlace.set(workspaceId, left)
      else inPlace.delete(workspaceId)
      notifyInPlace()
    }
  }, [workspaceId, active])
}

/** The head question as a modal, unless its workspace shows it in place. */
export function WorkspaceTrustDialog({ store = defaultStore }: { store?: TrustStore }): JSX.Element | null {
  const prompt = useSyncExternalStore(store.subscribe, store.current)
  const shownInPlace = useSyncExternalStore(subscribeInPlace, () => !!prompt && inPlace.has(prompt.workspaceId))
  const answering = useAnswer(store)

  if (!prompt || shownInPlace) return null

  return (
    <Modal
      onClose={() => answering.answer(false)}
      width={420}
      icon={ICON}
      title={TITLE}
      dismissable={!answering.busy}
      // Above Settings (z-[100001]): a workspace can open from there.
      zClassName="z-[100002]"
      bodyClassName="px-5 py-4"
    >
      <TrustQuestion prompt={prompt} answering={answering} />
    </Modal>
  )
}

/** The question about `workspaceId` as a card in the workspace's place,
 *  while it is the head of the queue. */
export function WorkspaceTrustCard({ workspaceId, store = defaultStore }: { workspaceId: string; store?: TrustStore }): JSX.Element | null {
  const prompt = useSyncExternalStore(store.subscribe, store.current)
  const answering = useAnswer(store)
  if (prompt?.workspaceId !== workspaceId) return null
  return (
    <ModalCard className="w-[420px] max-w-[92%]" icon={ICON} title={TITLE} showClose={false} bodyClassName="px-5 py-4">
      <div role="group" aria-label={TITLE}>
        <TrustQuestion prompt={prompt} answering={answering} />
      </div>
    </ModalCard>
  )
}

interface Answering {
  busy: boolean
  busyChoice: boolean | null
  error: string | null
  answer(trusted: boolean): void
}

function useAnswer(store: TrustStore): Answering {
  const [busyChoice, setBusyChoice] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const answer = (trusted: boolean): void => {
    setBusyChoice(trusted)
    setError(null)
    store.answer(trusted).then(
      () => setBusyChoice(null),
      (err: unknown) => {
        setError(errorMessage(err, 'Could not trust this workspace.'))
        setBusyChoice(null)
      },
    )
  }
  return { busy: busyChoice !== null, busyChoice, error, answer }
}

function TrustQuestion({ prompt, answering }: { prompt: TrustPrompt; answering: Answering }): JSX.Element {
  const { busy, busyChoice, error, answer } = answering
  return (
    <>
      <p className="text-[13px] leading-relaxed text-secondary">
        Trusting lets Cate run terminals, agents and git in this folder and apply the skills
        it ships in <code className="font-mono text-[12px]">.cate/</code>. A workspace's git config
        and files can run code on your machine through them.
      </p>

      {/* Which project is asking, which matters at launch when the person
          didn't open anything themselves. Breaks anywhere so a long path
          can't blow out the card. */}
      <div className="mt-3 px-2.5 py-2 rounded-md bg-surface-5 border border-subtle">
        <span className="text-[12px] text-muted font-mono break-all">{prompt.label}</span>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Only open workspaces you would run code from. This is remembered per workspace.
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
    </>
  )
}
