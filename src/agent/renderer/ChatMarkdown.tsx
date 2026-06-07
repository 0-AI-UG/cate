// =============================================================================
// ChatMarkdown — markdown rendering + small streaming indicators for the agent
// chat. Styles are tuned to match the panel chrome (tight spacing, agent
// accent for links/inline code).
// =============================================================================

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="agent-markdown space-y-2 break-words select-text cursor-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          h1: ({ children }) => <h1 className="text-[15px] font-semibold text-primary mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[14px] font-semibold text-primary mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[13.5px] font-semibold text-primary mt-2 mb-1">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer"
               className="text-agent-light underline decoration-agent-light/30 hover:decoration-agent-light">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-agent-light/40 pl-3 text-primary/80 italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-strong my-2" />,
          strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) {
              return (
                <code className={`${className ?? ''} font-mono text-[11.5px] leading-snug`} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="font-mono text-[11.5px] px-1 py-[1px] rounded bg-surface-0 text-agent-light" {...props}>
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="rounded-md bg-surface-0 border border-strong px-3 py-2 overflow-x-auto text-[11.5px] leading-snug">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="min-w-full text-[12px] border border-strong rounded-md">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="text-left px-2 py-1 border-b border-strong bg-hover font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-2 py-1 border-b border-subtle align-top">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export function CursorBlink() {
  return (
    <span className="inline-block w-[2px] h-[1em] align-middle bg-primary/80 ml-0.5 animate-pulse" />
  )
}

export function LoadingIndicator() {
  return (
    <div className="text-[12px] cate-fade-in">
      <span className="cate-notif-pulse">Loading</span>
    </div>
  )
}
