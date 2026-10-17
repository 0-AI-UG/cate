// A page's JavaScript dialog (`alert`, `confirm`, `prompt`), shown over the
// page it belongs to. The page waits until it is answered here or by an
// agent (`cate browser dialog`).

import { useEffect, useRef, useState } from 'react'
import type { BrowserDialog } from '@services/browser/contract'
import { Button, POPOVER_SURFACE } from '../../../kernel/interaction'

interface PageDialogProps {
  dialog: BrowserDialog & { id: string }
  origin: string
  onAnswer(accept: boolean, text?: string): void
}

export function PageDialog({ dialog, origin, onAnswer }: PageDialogProps): JSX.Element {
  const [text, setText] = useState(dialog.defaultPrompt ?? '')
  const input = useRef<HTMLInputElement | null>(null)
  const ok = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    setText(dialog.defaultPrompt ?? '')
    ;(input.current ?? ok.current)?.focus()
  }, [dialog.id, dialog.defaultPrompt])
  const accept = () => onAnswer(true, dialog.type === 'prompt' ? text : undefined)

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/30 pt-16" data-browser-dialog>
      <div
        role="alertdialog"
        aria-label={`${origin} says`}
        className={`flex w-96 max-w-[calc(100%-2rem)] flex-col gap-3 p-4 ${POPOVER_SURFACE}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onAnswer(false) }
          else if (event.key === 'Enter') { event.preventDefault(); accept() }
        }}
      >
        <div className="text-xs text-muted">{origin || 'This page'} says</div>
        <div className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm text-primary">{dialog.message}</div>
        {dialog.type === 'prompt' && (
          <input
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="rounded border border-subtle bg-transparent px-2 py-1 text-sm text-primary outline-none focus:border-strong"
          />
        )}
        <div className="flex justify-end gap-2">
          {dialog.type !== 'alert' && <Button size="sm" onClick={() => onAnswer(false)}>Cancel</Button>}
          <Button ref={ok} size="sm" variant="primary" onClick={accept}>OK</Button>
        </div>
      </div>
    </div>
  )
}
