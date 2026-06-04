// =============================================================================
// Onboarding tour steps.
//
// `target` is a CSS selector for the element to spotlight; omit it for a
// centered card. Anchored steps gracefully fall back to centered if the target
// isn't currently on screen, so the tour never breaks on a hidden element.
// =============================================================================

export interface OnboardingStep {
  id: string
  title: string
  body: string
  /** CSS selector of the element to highlight. Omit for a centered card. */
  target?: string
  /** Optional emoji shown above the title. */
  emoji?: string
  /** Optional keycap chips (e.g. ['⌘', 'K']). */
  keys?: string[]
  /** Clip the spotlight to the visible canvas area (between the sidebars),
   *  not the full canvas element which extends edge-to-edge behind them. */
  clipToVisibleCanvas?: boolean
  /** Hug the target's edges exactly (no outward padding, outline inset inward).
   *  Use for large container targets (canvas, sidebar) where padding would
   *  overshoot the real boundary; small targets keep the breathing room. */
  tight?: boolean
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'canvas',
    target: '[data-canvas-container]',
    clipToVisibleCanvas: true,
    tight: true,
    title: 'Your infinite canvas',
    body: 'Everything lives here. Drag panels anywhere, two-finger drag to pan, and ⌘ + scroll to zoom in and out.',
  },
  {
    id: 'toolbar',
    // Prefer the first-run welcome launcher; fall back to the canvas toolbar
    // (which only appears once the canvas has panels, e.g. on replay).
    target: '[data-onboarding="welcome-actions"], [data-onboarding="toolbar"]',
    title: 'Add anything',
    body: 'Spin up a terminal, editor, browser, or Pi agent — from here or the bottom toolbar. Drag one straight onto the canvas to place it exactly where you want.',
  },
  {
    id: 'sidebar',
    target: '[data-app-sidebar="left"]',
    tight: true,
    title: 'Your projects',
    body: 'Switch workspaces, open folders, and connect to remote machines over SSH from the sidebar.',
  },
  {
    id: 'palette',
    emoji: '⚡',
    title: 'One shortcut for everything',
    body: 'Press ⌘K to search files, jump between panels, and run any command — the fastest way to get around Cate.',
    keys: ['⌘', 'K'],
  },
  {
    id: 'done',
    emoji: '🚀',
    title: 'You’re all set',
    body: 'Build your first layout — drag panels around, then save and reuse layouts later. Replay this tour anytime from ⌘K → “Show Tutorial”.',
  },
]
