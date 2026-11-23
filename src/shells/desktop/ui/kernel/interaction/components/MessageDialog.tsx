// The message box, drawn in the app: a question or notice with its buttons as
// numbered rows. `showMessage(request)` resolves with the index of the button
// picked (Escape picks `cancelId`). `MessageDialogHost` is mounted once per
// window and draws the oldest pending message.

import { useEffect, useState } from 'react'
import { MENU_ROW, MENU_ROW_HIGHLIGHT } from './OptionsMenu'
import { Modal } from './Modal'

export interface MessageRequest {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

interface Pending { request: MessageRequest; resolve(index: number): void }

const queue: Pending[] = []
const listeners = new Set<() => void>()
const notify = () => { for (const l of [...listeners]) l() }

export function showMessage(request: MessageRequest): Promise<number> {
  return new Promise((resolve) => {
    queue.push({ request, resolve })
    notify()
  })
}

export function MessageDialogHost(): JSX.Element | null {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  const pending = queue[0]
  if (!pending) return null
  const { request } = pending
  const buttons = request.buttons.length > 0 ? request.buttons : ['OK']
  const cancel = request.cancelId ?? buttons.length - 1
  const done = (index: number) => { queue.shift(); pending.resolve(index); notify() }
  const preferred = request.defaultId ?? 0
  return (
    <Modal
      key={queue.length + request.message}
      title={request.message}
      width={380}
      dismissable={false}
      closeOnEscape
      numbered
      onClose={() => done(cancel)}
      hints={[
        ...(buttons.length > 1 ? [{ keys: ['1–' + Math.min(9, buttons.length)], label: 'Pick' }] : []),
        { keys: ['Enter'], label: 'Select' },
        ...(buttons.length > 1 ? [{ keys: ['Esc'], label: 'Cancel' }] : []),
      ]}
      showClose={false}
    >
      {request.detail && <p className="m-0 whitespace-pre-wrap break-words px-4 pb-2 text-[12px] leading-[1.45] text-muted">{request.detail}</p>}
      <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
        {buttons.map((label, index) => (
          <button
            key={label}
            type="button"
            data-menu-item
            data-autofocus={index === preferred ? '' : undefined}
            className={`${MENU_ROW} hover:bg-hover focus-visible:bg-hover ${index === preferred ? MENU_ROW_HIGHLIGHT : ''}`}
            onClick={() => done(index)}
          >
            <span className="flex-1 truncate">{label}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
