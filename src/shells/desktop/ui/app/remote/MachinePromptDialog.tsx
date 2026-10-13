// What ssh asks while it signs in to a machine (a password, a passphrase, a
// one-time code), in ssh's own words. Prompts queue: one at a time; one
// main withdraws (ssh stopped waiting) leaves the queue, and what was typed
// into it goes with it.

import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Modal, btn, inputCls } from '../../kernel/interaction'
import { useDesktopPort, type MachinePrompt } from '../desktop'

export function MachinePromptDialog(): JSX.Element | null {
  const port = useDesktopPort()
  const [queue, setQueue] = useState<MachinePrompt[]>([])

  useEffect(() => {
    if (!port) return
    const offPrompt = port.onMachinePrompt((prompt) => setQueue((q) => [...q, prompt]))
    const offCancel = port.onMachinePromptCancel((id) => setQueue((q) => q.filter((p) => p.id !== id)))
    return () => { offPrompt(); offCancel() }
  }, [port])

  const current = queue[0]
  if (!current || !port) return null
  const reply = (value: string | null) => {
    port.answerMachinePrompt(current.id, value)
    setQueue((q) => q.slice(1))
  }

  return <PromptDialog key={current.id} prompt={current} reply={reply} />
}

/** One prompt; keyed by its id, so its answer never outlives it. */
function PromptDialog({ prompt: current, reply }: { prompt: MachinePrompt; reply: (value: string | null) => void }): JSX.Element {
  const [answer, setAnswer] = useState('')
  return (
    <Modal
      onClose={() => reply(null)}
      width={420}
      icon={<KeyRound size={16} />}
      title={current.machine ? `Sign in to ${current.machine}` : 'Sign in'}
      zClassName="z-[100003]"
      bodyClassName="px-5 py-4"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          reply(answer)
        }}
      >
        <label className="flex flex-col gap-1.5 text-[13px] text-secondary">
          <span className="whitespace-pre-wrap break-words">{current.prompt.trim() || 'Password:'}</span>
          <input autoFocus type="password" aria-label="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} className={inputCls} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => reply(null)} className={btn.ghost}>Cancel</button>
          <button type="submit" className={btn.primary}>Continue</button>
        </div>
      </form>
    </Modal>
  )
}
