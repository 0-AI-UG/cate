// =============================================================================
// uiScale — apply the global UI scale to the current window.
//
// Scaling is done with Electron's webFrame.setZoomFactor (exposed via preload),
// which zooms the whole renderer DOM uniformly — panels, sidebars, the Monaco
// editor and the xterm terminal all scale together. webview content (browser
// panels) keeps its own zoom, which is the behaviour we want for a "UI scale".
//
// Each window owns its own webFrame, so every shell (main App, detached panel,
// detached dock) calls applyUiScale on mount and whenever the setting changes.
// =============================================================================

export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 2.0

export function applyUiScale(scale: number): void {
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Number.isFinite(scale) ? scale : 1))
  window.electronAPI?.setUiScale?.(clamped)
}
