// Shortcuts page (kernel/ui's shortcut slice): record, disable or reset each
// action's binding. Edits go through the installed shortcut registry, which
// stores only the overrides in `customShortcuts`.

import { useCallback, useEffect, useState } from 'react'
import { RotateCcw as ArrowCounterClockwise, X } from 'lucide-react'
import { Tooltip, matchesQuery, shortcutRegistry, useResolvedShortcuts, useSettingsSearch } from '@kernel/ui'
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_DISPLAY_NAMES,
  displayString,
  normaliseShortcutKey,
  type StoredShortcut,
} from '@kernel/ui/contract'

export function ShortcutsPage(): JSX.Element {
  const shortcuts = useResolvedShortcuts()
  const { query, sectionMatched } = useSettingsSearch()
  const visibleActions = SHORTCUT_ACTIONS.filter(
    (action) => sectionMatched || matchesQuery(SHORTCUT_DISPLAY_NAMES[action], query),
  )
  return (
    <div className="flex flex-col gap-0">
      {visibleActions.map((action) => (
        <div key={action} data-srow className="flex items-center justify-between py-2 border-b border-subtle">
          <span className="text-sm text-primary">{SHORTCUT_DISPLAY_NAMES[action]}</span>
          <div className="flex items-center gap-2">
            <ShortcutRecorder
              currentShortcut={shortcuts[action]}
              onRecord={(shortcut) => shortcutRegistry().set(action, shortcut)}
            />
            <Tooltip label="Disable shortcut">
              <button
                onClick={() => shortcutRegistry().clear(action)}
                disabled={!shortcuts[action].key}
                className="w-6 h-6 flex items-center justify-center rounded-[10px] hover:bg-hover text-muted hover:text-secondary disabled:opacity-30 disabled:hover:bg-transparent"
                aria-label="Disable shortcut"
              >
                <X size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Reset to default">
              <button
                onClick={() => shortcutRegistry().reset(action)}
                className="w-6 h-6 flex items-center justify-center rounded-[10px] hover:bg-hover text-muted hover:text-secondary"
                aria-label="Reset to default"
              >
                <ArrowCounterClockwise size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
      ))}
    </div>
  )
}

interface ShortcutRecorderProps {
  currentShortcut: StoredShortcut
  onRecord: (shortcut: StoredShortcut) => void
}

/** Click, then press a chord with at least one modifier; Escape or a click
 *  elsewhere cancels. */
function ShortcutRecorder({ currentShortcut, onRecord }: ShortcutRecorderProps): JSX.Element {
  const [recording, setRecording] = useState(false)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(false)
      return
    }
    if (['Meta', 'Shift', 'Alt', 'Control'].includes(e.key)) return
    if (!e.metaKey && !e.ctrlKey && !e.altKey) return
    onRecord({
      key: normaliseShortcutKey(e.key),
      command: e.metaKey,
      shift: e.shiftKey,
      option: e.altKey,
      control: e.ctrlKey,
    })
    setRecording(false)
  }, [recording, onRecord])

  useEffect(() => {
    if (!recording) return
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, handleKeyDown])

  useEffect(() => {
    if (!recording) return
    const cancel = () => setRecording(false)
    // Deferred so the click that started recording doesn't cancel it.
    const timer = setTimeout(() => document.addEventListener('click', cancel), 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', cancel)
    }
  }, [recording])

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        setRecording(true)
      }}
      className={`min-w-[80px] px-2 py-1 text-xs rounded-md border transition-colors text-center ${
        recording
          ? 'bg-focus-blue/20 border-focus-blue/50 text-focus-blue animate-pulse'
          : 'bg-surface-5 border-subtle text-primary hover:bg-hover'
      }`}
    >
      {recording ? 'Press keys...' : displayString(currentShortcut)}
    </button>
  )
}
