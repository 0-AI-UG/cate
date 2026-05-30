import { describe, it, expect } from 'vitest'
import encoder from 'plantuml-encoder'
import { buildPlantumlServerUrl } from './plantumlClient'

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
