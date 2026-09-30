import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MarkdownCodeBlock from './MarkdownCodeBlock'

// Stable renderer identities: re-renders must not replace pressed buttons or
// scroll containers, including code blocks nested inside lists and quotes.
const markdownComponents: Components = {
  p: ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
  h1: ({ children }) => <h1 className="text-xl font-bold text-primary mt-6 mb-2 pb-1 border-b border-strong">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold text-primary mt-5 mb-2 pb-1 border-b border-strong">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[15px] font-semibold text-primary mt-4 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-[14px] font-semibold text-primary mt-3 mb-1">{children}</h4>,
  ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-agent underline decoration-agent/30 hover:decoration-agent">{children}</a>
  ),
  blockquote: ({ children }) => <blockquote className="border-l-3 border-strong pl-3 text-secondary italic my-2">{children}</blockquote>,
  hr: () => <hr className="border-subtle my-4" />,
  strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children, ...props }) => /language-/.test(className ?? '')
    ? <code className={`${className ?? ''} font-mono text-[12px] leading-snug`} {...props}>{children}</code>
    : <code className="font-mono text-[12px] px-1 py-[1px] rounded bg-hover-strong text-primary" {...props}>{children}</code>,
  pre: MarkdownCodeBlock,
  table: ({ children }) => (
    <div className="overflow-x-auto my-3"><table className="min-w-full text-[12px] border border-subtle rounded-md">{children}</table></div>
  ),
  th: ({ children }) => <th className="text-left px-3 py-1.5 border-b border-subtle bg-surface-3 text-primary font-medium">{children}</th>,
  td: ({ children }) => <td className="px-3 py-1.5 border-b border-subtle align-top">{children}</td>,
  img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className="max-w-full rounded-md my-2" />,
}

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="absolute inset-0 overflow-auto px-6 py-4" data-testid="markdown-preview">
      <div className="max-w-3xl mx-auto prose-markdown space-y-3 [&>:first-child]:mt-0 text-[13px] text-primary leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
      </div>
    </div>
  )
}
