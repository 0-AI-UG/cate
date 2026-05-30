import { describe, it, expect } from 'vitest'
import { parseDiagramLang, nodeToText } from './diagramBlock'

describe('parseDiagramLang', () => {
  it('detects mermaid', () => {
    expect(parseDiagramLang('language-mermaid')).toBe('mermaid')
  })
  it('detects plantuml and its aliases', () => {
    expect(parseDiagramLang('language-plantuml')).toBe('plantuml')
    expect(parseDiagramLang('language-puml')).toBe('plantuml')
    expect(parseDiagramLang('language-uml')).toBe('plantuml')
  })
  it('is case-insensitive and tolerates extra classes', () => {
    expect(parseDiagramLang('foo language-MERMAID bar')).toBe('mermaid')
  })
  it('returns null for other languages and missing className', () => {
    expect(parseDiagramLang('language-python')).toBeNull()
    expect(parseDiagramLang(undefined)).toBeNull()
    expect(parseDiagramLang('')).toBeNull()
  })
})

describe('nodeToText', () => {
  it('flattens strings, numbers, arrays, and elements with children', () => {
    expect(nodeToText('hello')).toBe('hello')
    expect(nodeToText(['a', 'b', 'c'])).toBe('abc')
    expect(nodeToText(['line1\n', 'line2'])).toBe('line1\nline2')
    expect(nodeToText({ props: { children: 'nested' } } as never)).toBe('nested')
    expect(nodeToText(null)).toBe('')
    expect(nodeToText(undefined)).toBe('')
  })
})
