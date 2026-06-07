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
  keys?: string[]
  target?: string
  clipToVisibleCanvas?: boolean
  tight?: boolean
  openCommandPalette?: boolean
  hero?: boolean
}

const isMac =
  typeof navigator !== 'undefined' &&
  typeof navigator.platform === 'string' &&
  navigator.platform.toLowerCase().includes('mac')
const cmd = isMac ? '⌘' : 'Ctrl'

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'canvas',
    target: '[data-canvas-container]',
    clipToVisibleCanvas: true,
    tight: true,
    title: 'Your infinite canvas',
    body: `Everything lives here. Drag panels anywhere, two-finger drag to pan, and ${cmd} + scroll to zoom in and out.`,
  },
  {
    id: 'toolbar',
    target: '[data-onboarding="welcome-actions"], [data-onboarding="toolbar"]',
    title: 'Add anything',
    body: 'Spin up a terminal, editor, browser, or Cate agent from here or the bottom toolbar. Drag one straight onto the canvas to place it exactly where you want.',
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
    target: '[data-onboarding="command-palette"]',
    openCommandPalette: true,
    title: 'One shortcut for everything',
    body: `Press ${cmd}+K to search files, jump between panels, and run any command. The fastest way to get around Cate.`,
    keys: [cmd, 'K'],
  },
  {
    id: 'done',
    hero: true,
    title: 'You\'re all set',
    body: `Build your first layout: drag panels around, then save and reuse layouts later. Replay this tour anytime from **${cmd}+K → "Show Tutorial"**.`,
  },
]