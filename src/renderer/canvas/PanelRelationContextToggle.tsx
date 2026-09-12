import { useEffect, useState } from 'react'
import { Waypoints } from 'lucide-react'
import type { PanelState } from '../../shared/types'
import { compilePanelRelationContext } from '../../shared/panelRelations'
import { AGENTS } from '../../shared/agents'
import { useCliAgentByPanel } from '../hooks/useAgentPanelInfo'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { addAgentPromptGuidance } from '../lib/agent/panelRelationPrompt'
import { openUnsavedTextPanel } from '../lib/unsavedTextPanel'

const EMPTY_RELATIONS: NonNullable<ReturnType<typeof useAppStore.getState>['workspaces'][number]['panelRelations']> = []
const EMPTY_PANELS: ReturnType<typeof useAppStore.getState>['workspaces'][number]['panels'] = {}

export function PanelRelationContextToggle({ panel, workspaceId }: {
  panel: PanelState
  workspaceId: string
}) {
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const panels = useAppStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.panels ?? EMPTY_PANELS)
  const relations = useAppStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.panelRelations ?? EMPTY_RELATIONS)
  const panelRelationsEnabled = useSettingsStore((state) => state.panelRelationsEnabled)
  const cliAgentId = useCliAgentByPanel(workspaceId)[panel.id] ?? null
  const cliAgent = AGENTS.find((agent) => agent.id === cliAgentId)
  const compiled = compilePanelRelationContext(panel.id, panels, relations)
  const promptContext = panelRelationsEnabled && compiled ? addAgentPromptGuidance(compiled.text, cliAgentId) : null
  const connected = compiled !== null
  // Read the persisted toggle from the same store subscription as the graph.
  // Some hosts retain their PanelState prop while the panel remains mounted;
  // relying on that prop would leave the hook context enabled after a click.
  const currentPanel = panels[panel.id] ?? panel
  const mode = currentPanel.panelRelationContextMode
    ?? (currentPanel.panelRelationContextEnabled === false ? 'off' : 'once')
  const enabled = mode !== 'off'
  const transportSupported = panel.type === 'agent' || cliAgent?.promptContextHook != null
  const ptyId = panel.type === 'terminal' ? terminalRegistry.ptyIdForPanel(panel.id) : null
  const expanded = hovered || keyboardFocused || menuOpen

  const openMenu = async () => {
    if (menuOpen) return
    setMenuOpen(true)
    try {
      const choice = await window.electronAPI.showContextMenu([
        {
          label: `${compiled!.relatedPanelIds.length} connected panel${compiled!.relatedPanelIds.length === 1 ? '' : 's'} attached`,
          enabled: false,
        },
        { type: 'separator' },
        { id: 'once', label: `${mode === 'once' ? '✓ ' : ''}Next message` },
        { id: 'always', label: `${mode === 'always' ? '✓ ' : ''}Every message` },
        { id: 'off', label: `${mode === 'off' ? '✓ ' : ''}Off` },
        { type: 'separator' },
        { id: 'preview', label: 'Preview sent context…' },
      ])
      if (choice === 'once' || choice === 'always' || choice === 'off') {
        useAppStore.getState().setPanelRelationContextMode(workspaceId, panel.id, choice)
      } else if (choice === 'preview') {
        await openUnsavedTextPanel({
          workspaceId,
          sourcePanelId: panel.id,
          title: 'Connected panel context.md',
          content: promptContext ?? compiled!.text,
        })
      }
    } finally {
      setMenuOpen(false)
    }
  }

  useEffect(() => {
    if (!ptyId) return
    void window.electronAPI.agentHooksSetPromptContext(
      ptyId,
      transportSupported && enabled ? promptContext : null,
    )
  }, [enabled, promptContext, ptyId, transportSupported])

  useEffect(() => {
    if (!ptyId) return
    return () => { void window.electronAPI.agentHooksSetPromptContext(ptyId, null) }
  }, [ptyId])

  if (!panelRelationsEnabled || !connected || !transportSupported || panel.type !== 'terminal' && panel.type !== 'agent') {
    return null
  }

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
        {compiled.relatedPanelIds.length} panel{compiled.relatedPanelIds.length === 1 ? '' : 's'} · {mode === 'once' ? 'Next' : mode === 'always' ? 'Always' : 'Off'}
      </span>
    </button>
  )
}
