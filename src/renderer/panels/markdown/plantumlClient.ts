import encoder from 'plantuml-encoder'

/** Build a PlantUML server SVG URL for the given diagram source.
 *  Works with plantuml.com and self-hosted `plantuml-server` (same scheme). */
export function buildPlantumlServerUrl(serverUrl: string, source: string): string {
  const base = serverUrl.replace(/\/+$/, '')
  return `${base}/svg/${encoder.encode(source)}`
}

/** Render PlantUML locally via the main process; returns an <img>-ready
 *  data: URL, or throws with a human-readable message. */
export async function renderPlantumlLocalDataUrl(source: string, jarPath: string): Promise<string> {
  const res = await window.electronAPI.plantumlRender(source, jarPath)
  if (res.error || !res.svg) {
    throw new Error(res.error || 'PlantUML produced no output')
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(res.svg)}`
}
