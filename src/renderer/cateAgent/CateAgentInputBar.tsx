// =============================================================================
// CateAgentInputBar — replaces the toolbar's tool buttons while the Cate Agent
// input is open. A single text field + send button that prompts the Cate Agent.
// Enter sends; Escape closes input mode.
// =============================================================================

import React from 'react'
import { PaperPlaneTilt } from '@phosphor-icons/react'

export const CateAgentInputBar: React.FC<{
  onSend: (text: string) => void
  onClose: () => void
}> = ({ onSend, onClose }) => {
  const [text, setText] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => { inputRef.current?.focus() }, [])

  const send = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <div className="flex items-center gap-1.5 w-full pl-1 pr-1">
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); send() }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
        placeholder="Ask the Cate Agent…"
        className="flex-1 min-w-0 bg-transparent text-[13px] text-primary px-2 py-1.5 outline-none placeholder:text-muted"
      />
      <button
        type="button"
        onClick={send}
        disabled={!text.trim()}
        aria-label="Send"
        className="w-8 h-8 flex items-center justify-center rounded-full text-secondary hover:text-primary hover:bg-hover-strong active:scale-[0.92] transition-all duration-100 disabled:opacity-30"
      >
        <PaperPlaneTilt size={16} weight="fill" />
      </button>
    </div>
  )
}
