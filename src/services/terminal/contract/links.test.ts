import { describe, expect, it } from 'vitest'
import { osc8Target } from './links'

describe('osc8Target', () => {
  it('opens web URLs and file URIs, with a line from :12:5 or #L12', () => {
    expect(osc8Target('https://example.com/x')).toEqual({ kind: 'url', url: 'https://example.com/x' })
    expect(osc8Target('file:///repo/a%20b.ts')).toEqual({ kind: 'file', path: '/repo/a b.ts' })
    expect(osc8Target('file://host/repo/a.ts:12:5')).toEqual({ kind: 'file', path: '/repo/a.ts', line: 12, column: 5 })
    expect(osc8Target('file:///repo/a.ts#L7')).toEqual({ kind: 'file', path: '/repo/a.ts', line: 7 })
    expect(osc8Target('file:///C:/work/a.ts')).toEqual({ kind: 'file', path: 'C:/work/a.ts' })
  })

  it('ignores other schemes and junk', () => {
    expect(osc8Target('vscode://file/x')).toBeNull()
    expect(osc8Target('javascript:alert(1)')).toBeNull()
    expect(osc8Target('not a uri')).toBeNull()
  })
})
