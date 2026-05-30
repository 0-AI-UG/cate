import { describe, it, expect } from 'vitest'
import { parseDiagramLang, nodeToText, extractFencedDiagram } from './diagramBlock'

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

describe('extractFencedDiagram', () => {
  // react-markdown passes the <pre>'s children: a single <code> element (often
  // wrapped in a one-element array) with a `language-*` className.
  const codeEl = (className: string, children: unknown) => ({ props: { className, children } })

  it('extracts a mermaid fence and strips the trailing newline', () => {
    const el = codeEl('language-mermaid', 'flowchart TD\nA-->B\n')
    expect(extractFencedDiagram(el as never)).toEqual({ lang: 'mermaid', code: 'flowchart TD\nA-->B' })
  })
  it('handles a single-element array (react-markdown shape) and plantuml aliases', () => {
    const el = [codeEl('language-puml', '@startuml\nA->B\n')]
    expect(extractFencedDiagram(el as never)).toEqual({ lang: 'plantuml', code: '@startuml\nA->B' })
  })
  it('strips CRLF / CR trailing line endings (Windows sources)', () => {
    const el = codeEl('language-mermaid', 'a\r\nb\r\n')
    expect(extractFencedDiagram(el as never)).toEqual({ lang: 'mermaid', code: 'a\r\nb' })
  })
  it('returns null for non-diagram code fences', () => {
    expect(extractFencedDiagram(codeEl('language-python', 'print(1)\n') as never)).toBeNull()
  })
  it('returns null when there is no className or no element', () => {
    expect(extractFencedDiagram(codeEl('', 'x') as never)).toBeNull()
    expect(extractFencedDiagram('plain string' as never)).toBeNull()
    expect(extractFencedDiagram(undefined as never)).toBeNull()
  })
})
