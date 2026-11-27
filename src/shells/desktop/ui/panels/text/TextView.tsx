// The text panel's view: words in a box on the canvas, without panel chrome
// (frameless). The box is moved by a press and drag (on its edge, or on the
// words while they are not being edited) and resized like any node; the
// words wrap to its width and the box grows down when they need more room.
// A click puts the caret in the words. While the text is focused a dashed
// outline shows the box and a toolbar above it sets the size, weight, family
// and colour, or deletes it. A fresh text starts in editing, and a text left
// empty is removed when it is left.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Minus, Plus, Trash } from '@phosphor-icons/react'
import { documentStoreFor } from '@client/document'
import { closePanels } from '@client/host'
import {
  TEXT_COLOR_FIELD, TEXT_COLORS, TEXT_FAMILIES, TEXT_FAMILY_FIELD, TEXT_SIZE_FIELD, TEXT_SIZE_STEP, TEXT_WEIGHTS, TEXT_WEIGHT_FIELD,
  clampTextSize, textStyle, type TextColor, type TextFamily, type TextWeight,
} from '@panels/text/contract'
import type { JsonObject } from '@workspace/document/contract'
import type { PanelViewProps } from '../../client/host/views'
import { useCanvasNodeFrame } from '../../client/layout/canvas'
import { useT } from '../../kernel/settings'
import { useBlockText } from '../note'

/** Each colour's ink; `default` follows the theme's text. */
const INK: Record<TextColor, string | undefined> = {
  default: undefined,
  red: '#FF5F57',
  blue: '#0A84FF',
  green: '#32D74B',
  yellow: '#FFD60A',
  purple: '#BF5AF2',
}

const COLOR_NAMES: Record<TextColor, string> = {
  default: 'Default color',
  red: 'Red',
  blue: 'Blue',
  green: 'Green',
  yellow: 'Yellow',
  purple: 'Purple',
}

const WEIGHT_CSS: Record<TextWeight, number> = { regular: 400, medium: 500, bold: 700 }
const WEIGHT_LABEL: Record<TextWeight, { short: string; name: string }> = {
  regular: { short: 'R', name: 'Regular' },
  medium: { short: 'M', name: 'Medium' },
  bold: { short: 'B', name: 'Bold' },
}

const FAMILY_CSS: Record<TextFamily, string> = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
}
const FAMILY_LABEL: Record<TextFamily, string> = { sans: 'Sans', serif: 'Serif', mono: 'Mono' }

function ToolButton({ label, pressed, onClick, children, className = '', style }: {
  label: string
  pressed?: boolean
  onClick(): void
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[13px] transition-colors ${
        pressed ? 'bg-focus-blue/20 text-focus-blue' : 'text-primary hover:bg-hover-strong'
      } ${className}`}
      style={style}
    >
      {children}
    </button>
  )
}

const Divider = () => <div aria-hidden className="mx-1 h-5 w-px bg-surface-5" />

export default function TextView({ workspaceId, panelId, record, focused }: PanelViewProps) {
  const t = useT()
  const frame = useCanvasNodeFrame()
  const box = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const { value, change, leave } = useBlockText(workspaceId, record, field)
  const [editing, setEditing] = useState(false)
  const [colorsOpen, setColorsOpen] = useState(false)
  const removed = useRef(false)
  const style = textStyle(record)
  const active = editing || !!focused

  useEffect(() => { if (!active) setColorsOpen(false) }, [active])

  // A fresh, empty text taking focus (just created) starts in editing.
  useEffect(() => {
    const el = field.current
    if (focused && el && !el.value && document.activeElement !== el) el.focus()
  }, [focused])

  // The box grows down when the words need more room than it has.
  useLayoutEffect(() => {
    const el = field.current
    const outer = box.current
    if (!el || !outer || !frame) return
    const overflow = el.scrollHeight - el.clientHeight
    if (overflow > 0) frame.fit({ width: outer.offsetWidth, height: outer.offsetHeight + overflow })
  }, [frame, value, style.size, style.weight, style.family])

  const patch = (fields: JsonObject) =>
    documentStoreFor(workspaceId)?.propose({ kind: 'updatePanel', id: record.id, patch: { fields } })

  const setSize = (size: number) => {
    const next = clampTextSize(size)
    if (next !== style.size) patch({ [TEXT_SIZE_FIELD]: next })
  }

  const remove = () => {
    // Removed on purpose: the blur that follows must not close it a second time.
    removed.current = true
    void closePanels(workspaceId, [panelId])
  }

  return (
    <div
      ref={box}
      data-text-box
      className={`relative h-full w-full rounded-[10px] border-2 border-dashed p-1 ${
        active ? 'border-focus-blue' : 'border-transparent'
      }`}
      // The box's edge moves it, also while the words are being edited.
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        frame?.startDrag(event)
      }}
    >
      {active && (
        <div
          role="toolbar"
          aria-label={t('Text style')}
          className="absolute bottom-full left-0 mb-3 flex w-max items-center gap-0.5 rounded-full border border-subtle bg-surface-0 px-2 py-1 shadow-[0_8px_24px_-6px_var(--shadow-node)]"
          // Using the toolbar keeps the caret in the words, and is not a move.
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation() }}
        >
          <ToolButton label={t('Smaller')} onClick={() => setSize(style.size - TEXT_SIZE_STEP)}><Minus size={14} weight="bold" /></ToolButton>
          <span aria-label={t('Font size')} className="min-w-8 select-none text-center font-mono text-[13px] text-muted">{style.size}</span>
          <ToolButton label={t('Larger')} onClick={() => setSize(style.size + TEXT_SIZE_STEP)}><Plus size={14} weight="bold" /></ToolButton>
          <Divider />
          {TEXT_WEIGHTS.map((weight) => (
            <ToolButton
              key={weight}
              label={t(WEIGHT_LABEL[weight].name)}
              pressed={weight === style.weight}
              onClick={() => patch({ [TEXT_WEIGHT_FIELD]: weight })}
              style={{ fontWeight: WEIGHT_CSS[weight] }}
            >
              {WEIGHT_LABEL[weight].short}
            </ToolButton>
          ))}
          <Divider />
          {TEXT_FAMILIES.map((family) => (
            <ToolButton
              key={family}
              label={FAMILY_LABEL[family]}
              pressed={family === style.family}
              onClick={() => patch({ [TEXT_FAMILY_FIELD]: family })}
              style={{ fontFamily: FAMILY_CSS[family] }}
            >
              {FAMILY_LABEL[family]}
            </ToolButton>
          ))}
          <Divider />
          <div className="relative">
            <ToolButton label={t('Text color')} pressed={colorsOpen} onClick={() => setColorsOpen((open) => !open)}>
              <span className="h-4 w-4 rounded-full border border-subtle" style={{ backgroundColor: INK[style.color] ?? 'var(--text-primary)' }} />
            </ToolButton>
            {colorsOpen && (
              <div className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-subtle bg-surface-0 px-2 py-1.5 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
                {TEXT_COLORS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={t(COLOR_NAMES[option])}
                    title={t(COLOR_NAMES[option])}
                    aria-pressed={option === style.color}
                    onClick={() => { patch({ [TEXT_COLOR_FIELD]: option }); setColorsOpen(false) }}
                    className={`h-4 w-4 rounded-full ${option === style.color ? 'ring-2 ring-focus-blue ring-offset-1 ring-offset-surface-0' : ''}`}
                    style={{ backgroundColor: INK[option] ?? 'var(--text-primary)' }}
                  />
                ))}
              </div>
            )}
          </div>
          <Divider />
          <ToolButton label={t('Delete')} onClick={remove}><Trash size={16} /></ToolButton>
        </div>
      )}
      <textarea
        ref={field}
        data-text-block="text"
        aria-label={t('Text')}
        value={value}
        placeholder={t('Text')}
        spellCheck={false}
        onChange={(event) => change(event.target.value)}
        onMouseDown={(event) => {
          // Not editing: a press moves the box (or becomes a click below).
          if (document.activeElement === event.currentTarget || event.button !== 0) return
          event.preventDefault()
          frame?.startDrag(event)
        }}
        onClick={(event) => {
          const el = event.currentTarget
          if (document.activeElement === el || frame?.wasDragged()) return
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false)
          leave()
          // Left empty (and not just the window losing focus): it goes away.
          if (!removed.current && !field.current?.value.trim() && document.hasFocus()) void closePanels(workspaceId, [panelId])
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); field.current?.blur() }
        }}
        className={`block h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-2 py-1 leading-snug outline-none placeholder:text-muted ${
          editing ? 'cursor-text' : 'cursor-default'
        } ${style.color === 'default' ? 'text-primary' : ''}`}
        style={{
          color: INK[style.color],
          fontSize: style.size,
          fontWeight: WEIGHT_CSS[style.weight],
          fontFamily: FAMILY_CSS[style.family],
        }}
      />
    </div>
  )
}
