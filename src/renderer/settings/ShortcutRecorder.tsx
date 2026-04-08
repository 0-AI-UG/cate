import { useState, useEffect, useCallback } from 'react'
import type { ShortcutAction, StoredShortcut } from '../../shared/types'
import { displayString } from '../../shared/types'

interface ShortcutRecorderProps {
  action: ShortcutAction
  currentShortcut: StoredShortcut
  onRecord: (shortcut: StoredShortcut) => void
}

export function ShortcutRecorder({ action, currentShortcut, onRecord }: ShortcutRecorderProps) {
  const [isRecording, setIsRecording] = useState(false)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isRecording) return

      e.preventDefault()
      e.stopPropagation()

      // Escape cancels recording
      if (e.key === 'Escape') {
        setIsRecording(false)
        return
      }

      // Ignore bare modifier keys
      if (['Meta', 'Shift', 'Alt', 'Control'].includes(e.key)) return

      // Require at least one modifier
      if (!e.metaKey && !e.ctrlKey && !e.altKey) return

      const shortcut: StoredShortcut = {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        command: e.metaKey,
        shift: e.shiftKey,
        option: e.altKey,
        control: e.ctrlKey,
      }

      onRecord(shortcut)
      setIsRecording(false)
    },
    [isRecording, onRecord],
  )

  useEffect(() => {
    if (isRecording) {
      document.addEventListener('keydown', handleKeyDown, true)
      return () => document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isRecording, handleKeyDown])

  // Click outside cancels
  useEffect(() => {
    if (!isRecording) return
    const handleClick = () => setIsRecording(false)
    // Defer so the click that started recording doesn't immediately cancel
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
    }
  }, [isRecording])

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        setIsRecording(true)
      }}
      className={`min-w-[80px] px-2 py-1 text-xs rounded-md border transition-colors text-center ${
        isRecording
          ? 'bg-focus-blue/20 border-focus-blue/50 text-focus-blue animate-pulse'
          : 'bg-surface-5 border-subtle text-primary hover:bg-hover'
      }`}
    >
      {isRecording ? 'Press keys...' : displayString(currentShortcut)}
    </button>
  )
}
