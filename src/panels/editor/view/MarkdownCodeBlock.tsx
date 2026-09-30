import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import { Check, Copy } from 'lucide-react'
import { Tooltip, clientUi } from '@kernel/ui'
import { MermaidBlock } from './MermaidBlock'

/** Fenced code block with a hover copy button (on clients with a clipboard);
 *  `mermaid` fences render as diagrams. */
export default function MarkdownCodeBlock({ children, node }: { children?: ReactNode } & ExtraProps) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(resetTimer.current), [])
  const code = node?.children[0]
  if (code?.type === 'element' && code.tagName === 'code'
    && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
    const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
    return <MermaidBlock source={source} fallback={<MarkdownCodeBlock>{children}</MarkdownCodeBlock>} />
  }
  const writeClipboard = clientUi().writeClipboard
  const copyLabel = copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed. Try again' : 'Copy code'
  return (
    <div className="relative group my-3">
      <pre ref={preRef} className="rounded-md bg-surface-3 border border-subtle px-4 py-3 overflow-x-auto text-[12px] leading-snug">
        {children}
      </pre>
      {writeClipboard && (
        <Tooltip label={copyLabel}>
          <button
            onClick={async () => {
              clearTimeout(resetTimer.current)
              setCopyState('idle')
              try {
                await writeClipboard(preRef.current?.textContent ?? '')
                setCopyState('copied')
                resetTimer.current = setTimeout(() => setCopyState('idle'), 1200)
              } catch {
                setCopyState('error')
              }
            }}
            aria-label={copyLabel}
            className={`absolute top-1.5 right-1.5 p-1 rounded-[10px] bg-surface-3 text-muted transition-opacity hover:text-primary hover:bg-hover-strong ${
              copyState !== 'idle' ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </Tooltip>
      )}
    </div>
  )
}
