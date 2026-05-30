import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { buildPlantumlServerUrl, renderPlantumlLocalDataUrl } from './plantumlClient'

/** Renders a PlantUML diagram as an <img>. Server mode builds an encoded URL;
 *  local mode spawns java via the main process and shows the returned SVG as a
 *  data: URL. On failure, shows an actionable message + the raw source. */
export function PlantUmlDiagram({ code }: { code: string }) {
  const render = useSettingsStore((s) => s.plantumlRender)
  const serverUrl = useSettingsStore((s) => s.plantumlServerUrl)
  const jarPath = useSettingsStore((s) => s.plantumlJarPath)

  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setSrc(null)
    if (render === 'local') {
      renderPlantumlLocalDataUrl(code, jarPath)
        .then((url) => { if (!cancelled) setSrc(url) })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Render failed') })
    } else {
      if (!serverUrl.trim()) {
        setError('No PlantUML server URL. Set one in Settings → Diagrams.')
      } else if (!/^https?:\/\//i.test(serverUrl.trim())) {
        setError('PlantUML server URL must start with http:// or https://.')
      } else {
        setSrc(buildPlantumlServerUrl(serverUrl, code))
      }
    }
    return () => { cancelled = true }
  }, [code, render, serverUrl, jarPath])

  if (error) {
    return (
      <div className="my-3">
        <div className="text-[11px] text-red-500 mb-1">PlantUML error: {error}</div>
        <pre className="rounded-md bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 px-4 py-3 overflow-x-auto text-[12px] leading-snug">
          <code>{code}</code>
        </pre>
      </div>
    )
  }
  if (!src) return <div className="my-3 text-[11px] text-muted">Rendering diagram…</div>
  return (
    <div className="my-3 flex justify-center">
      <img
        src={src}
        alt="PlantUML diagram"
        className="max-w-full rounded-md bg-white p-2"
        onError={() => setError('Failed to render — check the PlantUML server URL or jar path.')}
      />
    </div>
  )
}
