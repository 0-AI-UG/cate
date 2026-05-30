import { useEffect, useRef, useState } from 'react'
import { getActiveTheme, subscribeTheme } from '../../lib/themeManager'

let renderSeq = 0

/** Renders a Mermaid diagram client-side. Lazy-loads the (large) mermaid bundle
 *  on first use; re-renders on code or theme change. Falls back to the raw
 *  source on parse errors so a broken diagram is still fixable. */
export function MermaidDiagram({ code }: { code: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [themeType, setThemeType] = useState(() => getActiveTheme().type)

  useEffect(() => subscribeTheme((t) => setThemeType(t.type)), [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    ;(async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: themeType === 'dark' ? 'dark' : 'default',
        })
        const id = `mermaid-${++renderSeq}`
        const { svg } = await mermaid.render(id, code)
        if (cancelled) return
        if (hostRef.current) hostRef.current.innerHTML = svg
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to render diagram')
      }
    })()
    return () => { cancelled = true }
  }, [code, themeType])

  if (error) {
    return (
      <div className="my-3">
        <div className="text-[11px] text-red-500 mb-1">Mermaid error: {error}</div>
        <pre className="rounded-md bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 px-4 py-3 overflow-x-auto text-[12px] leading-snug">
          <code>{code}</code>
        </pre>
      </div>
    )
  }
  return <div ref={hostRef} className="my-3 flex justify-center [&_svg]:max-w-full" />
}
