// =============================================================================
// Sound notification system — ported from NotificationManager.swift
// Plays debounced system sounds for terminal activity events.
// =============================================================================

import { useSettingsStore } from '../stores/settingsStore'

// -----------------------------------------------------------------------------
// Debounce state
// -----------------------------------------------------------------------------

const DEBOUNCE_INTERVAL = 1000 // 1 second — matches Swift debounceInterval
const lastPlayedTimes: Map<string, number> = new Map()

/**
 * Returns true if enough time has elapsed since the last play of this sound.
 * Side-effect: updates the timestamp if returning true.
 */
function shouldPlay(soundName: string): boolean {
  const now = Date.now()
  const lastPlayed = lastPlayedTimes.get(soundName) || 0
  if (now - lastPlayed < DEBOUNCE_INTERVAL) return false
  lastPlayedTimes.set(soundName, now)
  return true
}

// -----------------------------------------------------------------------------
// Public API — mirrors NotificationManager.swift
// -----------------------------------------------------------------------------

/**
 * Play the "command finished" sound (Glass on macOS).
 * Respects the soundNotificationsEnabled setting and debounce interval.
 */
export function playCommandFinished(): void {
  const settings = useSettingsStore.getState()
  if (!settings.soundNotificationsEnabled) return
  if (!shouldPlay('glass')) return
  playSound('glass')
}

/**
 * Play the "Claude needs input" sound (Funk on macOS).
 * Respects the soundNotificationsEnabled setting and debounce interval.
 */
export function playClaudeNeedsInput(): void {
  const settings = useSettingsStore.getState()
  if (!settings.soundNotificationsEnabled) return
  if (!shouldPlay('funk')) return
  playSound('funk')
}

// -----------------------------------------------------------------------------
// Sound playback
// -----------------------------------------------------------------------------

/**
 * Play a named sound. Uses the Electron IPC bridge if available (for macOS
 * system sounds via NSSound), otherwise falls back to Web Audio API with
 * bundled sound files.
 */
function playSound(name: string): void {
  // Primary path: Web Audio API with bundled sounds.
  // This is simpler and works without main process support for APP_PLAY_SOUND.
  try {
    const audio = new Audio(`./sounds/${name}.mp3`)
    audio.volume = 0.5
    audio.play().catch(() => {
      // Silently ignore — user may not have interacted with the page yet,
      // or the sound file may not exist.
    })
  } catch {
    // Silently ignore audio creation errors
  }
}
