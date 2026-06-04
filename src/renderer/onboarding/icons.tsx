// =============================================================================
// Onboarding step icons — small inline SVGs used in place of emoji so they
// render crisply and pick up the theme's accent color (via currentColor).
// =============================================================================

interface IconProps {
  size?: number
  className?: string
}

/** Lightning bolt — the "one shortcut for everything" step. */
function BoltIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M13.2 2.2a.7.7 0 0 1 1.2.62l-1.06 6.06h4.45a.7.7 0 0 1 .53 1.16l-8.7 10.04a.7.7 0 0 1-1.22-.62l1.06-6.06H5.04a.7.7 0 0 1-.53-1.16L13.2 2.2Z" />
    </svg>
  )
}

/** Rocket — the closing "you're all set" step. */
function RocketIcon({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M14.06 2.3c2.4-.86 4.93-.9 6.74-.7.32.04.57.29.6.6.2 1.82.17 4.35-.69 6.75-.62 1.73-1.66 3.4-3.32 4.86l.1 2.06a2 2 0 0 1-.76 1.66l-2.2 1.72c-.6.47-1.48.18-1.69-.55l-.62-2.16-3.3-3.3-2.16-.62c-.73-.21-1.02-1.09-.55-1.69l1.72-2.2a2 2 0 0 1 1.66-.76l2.06.1c1.46-1.66 3.13-2.7 4.86-3.32Zm1.69 5.65a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M6.3 16.2c-.7.46-1.3 1.32-1.72 2.18-.3.6-.5 1.2-.62 1.7a14.9 14.9 0 0 0 1.7-.62c.86-.42 1.72-1.02 2.18-1.72l-1.52-1.52Z" />
    </svg>
  )
}

const ICONS = { bolt: BoltIcon, rocket: RocketIcon }

export type OnboardingIconName = keyof typeof ICONS

export function OnboardingIcon({ name, size, className }: IconProps & { name: OnboardingIconName }) {
  const Cmp = ICONS[name]
  return <Cmp size={size} className={className} />
}
