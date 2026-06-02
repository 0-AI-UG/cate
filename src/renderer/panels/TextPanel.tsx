// =============================================================================
// TextPanel — a free-form text element that lives directly on the canvas with
// no window chrome (the bare rendering lives in CanvasNode). The whole element
// shares one text color, fill color, font size and font family. A compact
// floating toolbar appears above the block while it's active. Content +
// styling persist on the PanelState; position/size persist on the canvas node.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Minus, Plus, TextAa, PaintBucket } from '@phosphor-icons/react'
import type { PanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'

// Curated font stacks. Values are full CSS font-family stacks so they degrade
// gracefully on machines that lack the preferred face.
const FONT_FAMILIES: { label: string; value: string }[] = [
  { label: 'System', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", Times, serif' },
  { label: 'Mono', value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { label: 'Rounded', value: '"SF Pro Rounded", "Hiragino Maru Gothic ProN", "Nunito", system-ui, sans-serif' },
]

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 200
const DEFAULT_FONT_SIZE = 24
const DEFAULT_FONT_FAMILY = FONT_FAMILIES[0].value
// Shown in the color pickers before the user has chosen a value. The rendered
// text falls back to the theme's primary color; the fill falls back to none.
const DEFAULT_TEXT_PICKER = '#E6E6E6'
const DEFAULT_FILL_PICKER = '#FFD60A'
// Tiny checkerboard so a transparent fill swatch reads as "none".
const CHECKER =
  'repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 50% / 8px 8px'

const clampFontSize = (n: number): number =>
  Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(n)))

// Compact color swatch with a hidden native color input layered on top.
function Swatch({
  icon,
  title,
  value,
  display,
  onChange,
}: {
  icon: React.ReactNode
  title: string
  value: string
  display: string
  onChange: (v: string) => void
}) {
  return (
    <label
      className="relative flex items-center gap-1 cursor-pointer text-secondary hover:text-primary"
      title={title}
    >
      {icon}
      <span
        className="w-4 h-4 rounded border border-subtle shrink-0"
        style={{ background: display }}
      />
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
    </label>
  )
}

export default function TextPanel({ panelId, workspaceId, nodeId }: PanelProps) {
  const panel = useAppStore((s) => {
    const ws =
      s.workspaces.find((w) => w.id === workspaceId) ??
      s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    return ws?.panels[panelId]
  })
  const updateTextPanel = useAppStore((s) => s.updateTextPanel)
  // Whether this element's canvas node is currently active (focused/selected).
  // Drives toolbar visibility and auto-focus. Falls back to false in contexts
  // without a canvas store (text only ever lives on the canvas).
  const isNodeActive = useCanvasStoreContext((s) =>
    nodeId ? s.focusedNodeId === nodeId || s.selectedNodeIds.has(nodeId) : false,
  )

  const text = panel?.text ?? ''
  const color = panel?.textColor
  const bg = panel?.textBgColor
  const fontSize = panel?.textFontSize ?? DEFAULT_FONT_SIZE
  const fontFamily = panel?.textFontFamily ?? DEFAULT_FONT_FAMILY

  const taRef = useRef<HTMLTextAreaElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  // Make a freshly created or just-selected text block immediately editable.
  useEffect(() => {
    if (isNodeActive && taRef.current && document.activeElement !== taRef.current) {
      taRef.current.focus()
    }
  }, [isNodeActive])

  const patch = useCallback(
    (p: Parameters<typeof updateTextPanel>[2]) => updateTextPanel(workspaceId, panelId, p),
    [updateTextPanel, workspaceId, panelId],
  )

  const setFontSize = useCallback(
    (next: number) => patch({ textFontSize: clampFontSize(next) }),
    [patch],
  )

  const showToolbar = isNodeActive || focused || hovered
  const colorStyle = color ?? 'var(--text-primary)'

  return (
    <div
      className="relative w-full h-full"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Floating formatting toolbar — sits just above the block while active. */}
      {showToolbar && (
        <div
          className="absolute left-0 -top-10 flex items-center gap-2 px-2 py-1 rounded-lg border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)] text-secondary"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Swatch
            icon={<TextAa size={14} />}
            title="Text color"
            value={color ?? DEFAULT_TEXT_PICKER}
            display={color ?? DEFAULT_TEXT_PICKER}
            onChange={(v) => patch({ textColor: v })}
          />
          <Swatch
            icon={<PaintBucket size={14} />}
            title="Fill color"
            value={bg ?? DEFAULT_FILL_PICKER}
            display={bg ?? CHECKER}
            onChange={(v) => patch({ textBgColor: v })}
          />

          <div className="w-px h-4 bg-surface-5" />

          {/* Font size */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setFontSize(fontSize - 2)}
              title="Decrease font size"
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-hover-strong hover:text-primary"
            >
              <Minus size={12} />
            </button>
            <input
              type="number"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={fontSize}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                if (!Number.isNaN(n)) setFontSize(n)
              }}
              title="Font size (px)"
              className="w-10 h-5 text-center text-[11px] tabular-nums rounded bg-surface-2 text-primary border border-subtle outline-none focus:border-focus"
            />
            <button
              type="button"
              onClick={() => setFontSize(fontSize + 2)}
              title="Increase font size"
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-hover-strong hover:text-primary"
            >
              <Plus size={12} />
            </button>
          </div>

          <div className="w-px h-4 bg-surface-5" />

          {/* Font family */}
          <select
            value={fontFamily}
            onChange={(e) => patch({ textFontFamily: e.target.value })}
            title="Font family"
            className="h-5 max-w-[7rem] text-[11px] rounded bg-surface-2 text-primary border border-subtle outline-none focus:border-focus px-1 cursor-pointer"
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Editable text + fill */}
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => patch({ text: e.target.value })}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Type something…"
        spellCheck={false}
        className="w-full h-full resize-none outline-none px-2 py-1.5 leading-snug placeholder:text-muted"
        style={{
          color: colorStyle,
          fontSize: `${fontSize}px`,
          fontFamily,
          background: bg ?? 'transparent',
          borderRadius: 6,
        }}
      />
    </div>
  )
}
