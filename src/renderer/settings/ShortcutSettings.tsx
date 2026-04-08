import { useShortcutStore } from '../stores/shortcutStore'
import { SHORTCUT_ACTIONS, SHORTCUT_DISPLAY_NAMES, displayString } from '../../shared/types'
import type { ShortcutAction } from '../../shared/types'
import { ShortcutRecorder } from './ShortcutRecorder'
import { ArrowCounterClockwise } from '@phosphor-icons/react'

export function ShortcutSettings() {
  const shortcuts = useShortcutStore((s) => s.shortcuts)
  const resetShortcut = useShortcutStore((s) => s.resetShortcut)
  const resetAll = useShortcutStore((s) => s.resetAll)

  return (
    <div className="flex flex-col gap-0">
      {SHORTCUT_ACTIONS.map((action) => (
        <div
          key={action}
          className="flex items-center justify-between py-2 border-b border-subtle"
        >
          <span className="text-sm text-primary">
            {SHORTCUT_DISPLAY_NAMES[action]}
          </span>
          <div className="flex items-center gap-2">
            <ShortcutRecorder
              action={action}
              currentShortcut={shortcuts[action]}
              onRecord={(shortcut) => useShortcutStore.getState().setShortcut(action, shortcut)}
            />
            <button
              onClick={() => resetShortcut(action)}
              className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-hover text-muted hover:text-secondary"
              title="Reset to default"
            >
              <ArrowCounterClockwise size={12} />
            </button>
          </div>
        </div>
      ))}
      <div className="mt-4 flex justify-end">
        <button
          onClick={resetAll}
          className="px-3 py-1.5 text-xs text-secondary hover:text-primary bg-surface-5 hover:bg-hover rounded-md transition-colors"
        >
          Reset All to Defaults
        </button>
      </div>
    </div>
  )
}
