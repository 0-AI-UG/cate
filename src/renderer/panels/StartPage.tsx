// =============================================================================
// StartPage — deliberately sparse browser new-tab content. Navigation belongs
// in the persistent address bar above it.
// =============================================================================
import { Globe } from '@phosphor-icons/react'

export function StartPage(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-0">
      <div className="flex -translate-y-3 flex-col items-center text-center">
        <Globe size={28} weight="regular" className="mb-5 text-secondary" />
        <h1 className="text-base font-semibold text-primary">Browse</h1>
        <p className="mt-3 text-sm text-secondary">Enter a URL to open a page</p>
      </div>
    </div>
  )
}
