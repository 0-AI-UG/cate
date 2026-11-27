// The note panel's view: a yellow sticky note drawn without panel chrome
// (`chrome.frameless`). Its top band moves the note; its body is the words,
// edited in place ("Click to edit…"). A fresh note starts in editing.

import { useEffect, useRef } from 'react'
import type { PanelViewProps } from '../../client/host/views'
import { useCanvasNodeFrame } from '../../client/layout/canvas'
import { useT } from '../../kernel/settings'
import { useBlockText } from './useBlockText'

/** A paper note keeps its colours in every theme. */
const NOTE_PAPER = '#FFF9C4'
const NOTE_BAND = '#F1EBBE'
const NOTE_INK = '#3B3A2F'

export default function NoteView({ workspaceId, record, focused }: PanelViewProps) {
  const t = useT()
  const frame = useCanvasNodeFrame()
  const field = useRef<HTMLTextAreaElement>(null)
  const { value, change, leave } = useBlockText(workspaceId, record, field)

  // A fresh, empty note taking focus (just created) starts in editing.
  useEffect(() => {
    const el = field.current
    if (focused && el && !el.value && document.activeElement !== el) el.focus()
  }, [focused])

  return (
    <div
      data-note
      className="flex h-full w-full flex-col overflow-hidden rounded-[12px] shadow-[0_16px_36px_-14px_rgba(0,0,0,0.6),0_4px_12px_-4px_rgba(0,0,0,0.35)]"
      style={{ backgroundColor: NOTE_PAPER }}
    >
      <div
        data-note-handle
        aria-hidden
        className="h-[34px] shrink-0 cursor-grab active:cursor-grabbing"
        style={{ backgroundColor: NOTE_BAND }}
        onMouseDown={(event) => frame?.startDrag(event)}
      />
      <textarea
        ref={field}
        data-text-block="note"
        aria-label={t('Note')}
        value={value}
        rows={1}
        placeholder={t('Click to edit…')}
        spellCheck
        onChange={(event) => change(event.target.value)}
        onBlur={leave}
        onKeyDown={(event) => {
          // Escape leaves editing; the note keeps its place.
          if (event.key === 'Escape') { event.preventDefault(); field.current?.blur() }
        }}
        className="block min-h-0 w-full flex-1 resize-none bg-transparent px-5 py-4 font-mono text-[15px] leading-relaxed outline-none placeholder:italic placeholder:text-[#8C8A7A]"
        style={{ color: NOTE_INK }}
      />
    </div>
  )
}
