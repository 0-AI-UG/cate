import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { extractFencedDiagram } from './diagramBlock'
import { MermaidDiagram } from './MermaidDiagram'
import { PlantUmlDiagram } from './PlantUmlDiagram'

// Defined at module scope (not inline in the component) so their identities are
// stable across renders. react-markdown keys child rendering off the component
// functions in `components`; recreating them every render would give every
// child — including the async diagram components — a new type, forcing React to
// unmount + remount them on each parent re-render (which is frequent), causing
// the diagrams to re-render and visibly "jump".
const REMARK_PLUGINS = [remarkGfm]

const COMPONENTS: Components = {
  p: ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
  h1: ({ children }) => <h1 className="text-xl font-bold text-primary mt-6 mb-2 pb-1 border-b border-strong">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold text-primary mt-5 mb-2 pb-1 border-b border-strong">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[15px] font-semibold text-primary mt-4 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-[14px] font-semibold text-primary mt-3 mb-1">{children}</h4>,
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer"
       className="text-agent underline decoration-agent/30 hover:decoration-agent">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-3 border-strong pl-3 text-secondary italic my-2">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-subtle my-4" />,
  strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <code className={`${className ?? ''} font-mono text-[12px] leading-snug`} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className="font-mono text-[12px] px-1 py-[1px] rounded bg-hover-strong text-primary" {...props}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => {
    // react-markdown renders fenced blocks as <pre><code class="language-x">.
    // Intercept diagram languages before the normal code-card wrapper.
    const diagram = extractFencedDiagram(children)
    if (diagram) {
      if (diagram.lang === 'mermaid') return <MermaidDiagram code={diagram.code} />
      return <PlantUmlDiagram code={diagram.code} />
    }
    return (
      <pre className="rounded-md bg-surface-3 border border-subtle px-4 py-3 overflow-x-auto text-[12px] leading-snug my-3">
        {children}
      </pre>
    )
  },
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="min-w-full text-[12px] border border-subtle rounded-md">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="text-left px-3 py-1.5 border-b border-subtle bg-surface-3 text-primary font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-1.5 border-b border-subtle align-top">{children}</td>
  ),
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ''} className="max-w-full rounded-md my-2" />
  ),
}

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="absolute inset-0 overflow-auto px-6 py-4">
      <div className="max-w-3xl mx-auto prose-markdown space-y-3 text-[13px] text-primary leading-relaxed">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
