import { describe, expect, it } from 'vitest'
import { canContain, excludedChildTypes } from './panels'

describe('canContain', () => {
  it('docks host anything', () => {
    for (const t of ['canvas', 'container', 'terminal'] as const) expect(canContain('dock', t)).toBe(true)
  })
  it('canvas rejects canvas but accepts container', () => {
    expect(canContain('canvas', 'canvas')).toBe(false)
    expect(canContain('canvas', 'container')).toBe(true)
  })
  it('container rejects container but accepts canvas', () => {
    expect(canContain('container', 'container')).toBe(false)
    expect(canContain('container', 'canvas')).toBe(true)
    expect(excludedChildTypes('container')).toEqual(['container'])
  })
})
