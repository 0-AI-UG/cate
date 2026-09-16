import { useRef, useState, type ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import { Check, Copy } from 'lucide-react'
import { Tooltip } from '../ui/Tooltip'
import { MermaidBlock } from './MermaidBlock'

/** Fenced code block with a hover copy button, matching the agent chat's
 *  "Copy code" affordance (#373). */
export default function MarkdownCodeBlock({ children, node }: { children?: ReactNode } & ExtraProps) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const code = node?.children[0]
  if (code?.type === 'element' && code.tagName === 'code'
    && Array.isArray(code.properties.className) && code.properties.className.includes('language-mermaid')) {
    const source = code.children.map(child => child.type === 'text' ? child.value : '').join('')
    return <MermaidBlock source={source} fallback={<MarkdownCodeBlock>{children}</MarkdownCodeBlock>} />
  }
  return (
    <div className="relative group my-3">
      <pre
        ref={preRef}
        className="rounded-md bg-surface-3 border border-subtle px-4 py-3 overflow-x-auto text-[12px] leading-snug"
      >
        {children}
      </pre>
      <Tooltip label="Copy code">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(preRef.current?.textContent ?? '')
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          }}
          aria-label="Copy code"
          className={`absolute top-1.5 right-1.5 p-1 rounded-[10px] bg-surface-3 text-muted transition-opacity hover:text-primary hover:bg-hover-strong ${
            copied ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </Tooltip>
    </div>
  )
}

