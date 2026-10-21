// Agent status marks drawn next to a panel's title (dock tabs, sidebar rows).
// Running is the title's shimmer (ShimmerText), not a mark.

const AWAIT_COLOR = 'color-mix(in srgb, var(--activity-orange) 70%, var(--text-primary))'

export function AwaitingIndicator({ className = '' }: { className?: string }) {
  return (
    <span className={`cate-await-indicator shrink-0 ${className}`} aria-label="awaiting input">
      <span className="cate-await-dot" style={{ backgroundColor: AWAIT_COLOR }} />
    </span>
  )
}
