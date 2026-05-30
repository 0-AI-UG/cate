import { describe, it, expect, vi, beforeEach } from 'vitest'
import encoder from 'plantuml-encoder'
import { buildPlantumlServerUrl, renderPlantumlLocalDataUrl } from './plantumlClient'

const SRC = '@startuml\nBob -> Alice : hello\n@enduml'

describe('buildPlantumlServerUrl', () => {
  it('builds <server>/svg/<encoded> and round-trips the source', () => {
    const url = buildPlantumlServerUrl('https://www.plantuml.com/plantuml', SRC)
    expect(url.startsWith('https://www.plantuml.com/plantuml/svg/')).toBe(true)
    const encoded = url.slice('https://www.plantuml.com/plantuml/svg/'.length)
    expect(encoder.decode(encoded)).toBe(SRC)
  })
  it('strips a trailing slash from the server URL', () => {
    const url = buildPlantumlServerUrl('http://localhost:8080/', SRC)
    expect(url.startsWith('http://localhost:8080/svg/')).toBe(true)
    expect(url).not.toContain('//svg/')
  })
})

describe('renderPlantumlLocalDataUrl', () => {
  const plantumlRender = vi.fn()

  beforeEach(() => {
    plantumlRender.mockReset()
    ;(globalThis as unknown as { window: unknown }).window = { electronAPI: { plantumlRender } }
  })

  it('returns a unicode-safe charset=utf-8 data URL on success', async () => {
    const svg = '<svg>café</svg>'
    plantumlRender.mockResolvedValue({ svg })
    const url = await renderPlantumlLocalDataUrl('src', '/x.jar')
    expect(url).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    expect(plantumlRender).toHaveBeenCalledWith('src', '/x.jar')
  })

  it('throws with the handler error message', async () => {
    plantumlRender.mockResolvedValue({ error: 'java boom' })
    await expect(renderPlantumlLocalDataUrl('s', '/x.jar')).rejects.toThrow('java boom')
  })

  it('throws when the handler returns no svg', async () => {
    plantumlRender.mockResolvedValue({})
    await expect(renderPlantumlLocalDataUrl('s', '/x.jar')).rejects.toThrow('PlantUML produced no output')
  })
})
