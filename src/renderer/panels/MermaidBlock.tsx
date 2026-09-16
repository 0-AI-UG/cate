import { useEffect, useState, type ReactNode } from 'react'
import { getActiveTheme, subscribeTheme } from '../lib/themeManager'

// Mermaid configuration is global. Serialize initialization and rendering so
// multiple blocks (or a theme change) cannot change an in-flight render's theme.
let renderQueue: Promise<unknown> = Promise.resolve()
let nextId = 0

export function MermaidBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
  const [theme, setTheme] = useState(() => getActiveTheme().type)
  const [result, setResult] = useState<{ source: string; theme: string; svg?: string; error?: boolean }>()

  useEffect(() => subscribeTheme(next => setTheme(next.type)), [])
  useEffect(() => {
    let cancelled = false
    const render = renderQueue.then(async () => {
      if (cancelled) return
      const { default: mermaid } = await import('mermaid')
      if (cancelled) return
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: theme === 'dark' ? 'dark' : 'default',
      })
      const { svg } = await mermaid.render(`cate-mermaid-${++nextId}`, source)
      if (!cancelled) setResult({ source, theme, svg })
    })
    renderQueue = render.catch(() => {
      if (!cancelled) setResult({ source, theme, error: true })
    })
    return () => { cancelled = true }
  }, [source, theme])

  const current = result?.source === source && result.theme === theme ? result : undefined
  return (
    <div className="my-3">
      {current?.svg ? (
        <>
          <div className="overflow-x-auto rounded-md border border-subtle p-3 [&>svg]:mx-auto"
            role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: current.svg }} />
          <details className="mt-1 text-muted">
            <summary className="cursor-pointer text-xs">Diagram source</summary>
            {fallback}
          </details>
        </>
      ) : (
        <>
          <p role="status" className="text-xs text-muted">
            {current?.error ? 'Unable to render Mermaid diagram. Check the source below.' : 'Rendering diagram…'}
          </p>
          {fallback}
        </>
      )}
    </div>
  )
}
