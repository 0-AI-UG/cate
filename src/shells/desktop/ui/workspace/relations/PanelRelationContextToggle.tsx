// The execution panel's chip for connected-panel context: how many panels
// are attached and when they go with a prompt (next message, every message,
// off). Spelled out while context is armed and for a moment after it was
// sent; an icon otherwise. Hidden when relations are off, nothing is
// connected, or the panel's agent has no prompt context hook.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Waypoints } from 'lucide-react'
import type { PanelRecord } from '@workspace/document/contract'
import { compileRelationContext, isExecutionSurface, relationPanelOf, relationPanels } from '@workspace/relations/contract'
import { relationContextMode, setRelationContextMode } from './actions'
import { relationRoleOf, useRelationMap, useRelationPanels, useRelationsEnabled } from './host'
import { relationUiPort } from './port'

export function PanelRelationContextToggle({ panel, workspaceId }: {
  panel: PanelRecord
  workspaceId: string
}) {
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const records = useRelationPanels(workspaceId)
  const relationMap = useRelationMap(workspaceId)
  const panelRelationsEnabled = useRelationsEnabled(workspaceId)
  // A host may keep a stale record prop while the panel stays mounted.
  const currentPanel = records[panel.id] ?? panel
  const transport = relationUiPort().useContextTransport(workspaceId, currentPanel)
  const compiled = useMemo(() => {
    return compileRelationContext(panel.id, relationPanels(Object.values(records), relationRoleOf), Object.values(relationMap))
  }, [panel.id, records, relationMap])
  const promptContext = panelRelationsEnabled && compiled && transport ? transport.decorate(compiled.text) : null
  const mode = relationContextMode(currentPanel.fields)
  const enabled = mode !== 'off'
  const justSent = useJustSent(transport?.sentAt)
  const expanded = hovered || keyboardFocused || menuOpen || enabled || justSent

  const openMenu = async () => {
    if (menuOpen || !compiled) return
    setMenuOpen(true)
    try {
      const count = compiled.relatedPanelIds.length
      const choice = await relationUiPort().showMenu([
        { label: `${count} connected panel${count === 1 ? '' : 's'} attached`, enabled: false },
        { type: 'separator' },
        { id: 'once', label: `${mode === 'once' ? '✓ ' : ''}Next message` },
        { id: 'always', label: `${mode === 'always' ? '✓ ' : ''}Every message` },
        { id: 'off', label: `${mode === 'off' ? '✓ ' : ''}Off` },
        { type: 'separator' },
        { id: 'preview', label: 'Preview sent context…' },
      ])
      if (choice === 'once' || choice === 'always' || choice === 'off') {
        setRelationContextMode(workspaceId, panel.id, choice)
      } else if (choice === 'preview') {
        await relationUiPort().openTextPreview({
          workspaceId,
          sourcePanelId: panel.id,
          title: 'Connected panel context.md',
          content: promptContext ?? compiled.text,
        })
      }
    } finally {
      setMenuOpen(false)
    }
  }

  if (!panelRelationsEnabled || !compiled || !transport || !isExecutionSurface(relationPanelOf(currentPanel, relationRoleOf))) return null

  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label={`${compiled.relatedPanelIds.length} connected panels, ${mode === 'once' ? 'next message' : mode === 'always' ? 'every message' : 'off'}`}
      title="Choose when connected panels are included"
      className={`inline-flex h-[20px] min-w-0 items-center rounded-full border transition-[border-color,background-color,color,filter] ${enabled
        ? 'border-focus-blue bg-focus-blue text-white shadow-sm hover:brightness-110'
        : 'border-subtle bg-surface-3 text-muted hover:border-strong hover:text-primary'}`}
      style={{
        gap: expanded ? 4 : 0,
        padding: expanded ? '0 6px' : '0 4px',
        transition: 'border-color 150ms ease, background-color 150ms ease, color 150ms ease, filter 150ms ease, gap 150ms ease, padding 150ms ease',
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => setKeyboardFocused(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => setKeyboardFocused(false)}
      onClick={(event) => {
        event.stopPropagation()
        void openMenu()
      }}
    >
      <Waypoints size={11} className="shrink-0" />
      <span
        className="overflow-hidden whitespace-nowrap text-[10px]"
        style={{
          maxWidth: expanded ? 180 : 0,
          opacity: expanded ? 1 : 0,
          transition: 'max-width 150ms ease, opacity 150ms ease',
        }}
      >
        {justSent ? 'Context sent · ' : ''}{compiled.relatedPanelIds.length} panel{compiled.relatedPanelIds.length === 1 ? '' : 's'}{justSent ? '' : ` · ${mode === 'once' ? 'Next' : mode === 'always' ? 'Always' : 'Off'}`}
      </span>
    </button>
  )
}

const SENT_NOTE_MS = 4000

/** True for a few seconds after `sentAt` changes while mounted. It is the
 *  runtime's clock, so it is only compared with itself. */
function useJustSent(sentAt: number | undefined): boolean {
  const [shown, setShown] = useState(false)
  const first = useRef(sentAt)
  useEffect(() => {
    if (sentAt === undefined || sentAt === first.current) return
    first.current = undefined
    setShown(true)
    const timer = setTimeout(() => setShown(false), SENT_NOTE_MS)
    return () => clearTimeout(timer)
  }, [sentAt])
  return shown
}
