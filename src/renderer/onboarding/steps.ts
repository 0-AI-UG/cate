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
  /** Optional community links rendered as buttons (e.g. on the final card). */
  links?: { label: string; url: string; track: string; icon: 'github' | 'newsletter' }[]
}

const GITHUB_REPO = 'https://github.com/0-AI-UG/cate'
const NEWSLETTER_URL = 'https://cate.cero-ai.com'

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    emoji: '👋',
    title: 'Welcome to Cate',
    body: 'Cate is an infinite canvas for building — terminals, editors, browsers, and AI agents, all floating in one space. Here’s a 30-second tour.',
  },
  {
    id: 'canvas',
    target: '[data-canvas-container]',
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
    body: 'Build your first layout — and replay this tour anytime from ⌘K → “Show Tutorial”. If Cate’s useful to you, a star or a subscribe goes a long way.',
    links: [
      { label: 'Star on GitHub', url: GITHUB_REPO, track: 'github_star', icon: 'github' },
      { label: 'Newsletter', url: NEWSLETTER_URL, track: 'newsletter', icon: 'newsletter' },
    ],
  },
]
