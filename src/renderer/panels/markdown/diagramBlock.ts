import type { ReactNode } from 'react'

export type DiagramLang = 'mermaid' | 'plantuml'

/** Map a code element's className (e.g. "language-mermaid") to a diagram kind,
 *  or null if it is not a diagram fence. Recognises plantuml/puml/uml aliases. */
export function parseDiagramLang(className: string | undefined): DiagramLang | null {
  if (!className) return null
  const m = /language-([a-z]+)/i.exec(className)
  if (!m) return null
  const lang = m[1].toLowerCase()
  if (lang === 'mermaid') return 'mermaid'
  if (lang === 'plantuml' || lang === 'puml' || lang === 'uml') return 'plantuml'
  return null
}

/** Flatten react-markdown's code children (string | string[] | element tree)
 *  into the raw fenced text. */
export function nodeToText(node: ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  // React element: recurse into its children prop.
  const props = (node as { props?: { children?: ReactNode } }).props
  if (props && 'children' in props) return nodeToText(props.children)
  return ''
}

/** Given the `children` of a react-markdown `<pre>` override (a single `<code>`
 *  element), return the diagram kind + source if it is a diagram fence, else
 *  null. Strips the trailing newline(s) react-markdown leaves on fenced text
 *  (handles CR, LF, or CRLF line endings). */
export function extractFencedDiagram(children: ReactNode): { lang: DiagramLang; code: string } | null {
  const child = Array.isArray(children) ? children[0] : children
  const props = (child as { props?: { className?: string; children?: ReactNode } } | undefined)?.props
  const lang = parseDiagramLang(props?.className)
  if (!lang) return null
  const code = nodeToText(props?.children).replace(/[\r\n]+$/, '')
  return { lang, code }
}
