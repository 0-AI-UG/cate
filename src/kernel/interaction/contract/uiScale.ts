// The global UI scale zooms Cate's own chrome in one window (panels, sidebars,
// Monaco and xterm together). Web pages in browser panels keep their own zoom.

export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 2.0

export function clampUiScale(scale: number): number {
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Number.isFinite(scale) ? scale : 1))
}
