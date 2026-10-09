import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fsClient } from '@workspace/files/client'
import MarkdownCodeBlock from './MarkdownCodeBlock'

/** Where the previewed file lives: its images are workspace files. */
const PreviewFile = createContext<{ workspaceId: string; filePath: string } | null>(null)

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
}

/** The workspace path an image `src` names, relative to the markdown file;
 *  null for web and inline images, which load as they are. */
export function markdownImagePath(src: string, filePath: string): string | null {
  if (/^(https?:|data:|blob:)/i.test(src)) return null
  let path = src.replace(/[?#].*$/, '')
  try { path = decodeURI(path) } catch { /* keep it as written */ }
  if (/^file:\/\//i.test(path)) path = path.slice('file://'.length).replace(/^\/([A-Za-z]:)/, '$1')
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) return path
  const segments = filePath.replace(/\\/g, '/').split('/').slice(0, -1)
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') segments.pop()
    else if (part && part !== '.') segments.push(part)
  }
  return segments.join('/')
}

/** A markdown image: workspace files are read through the workspace's
 *  runtime (never this device's disk), the same for every runtime. */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const file = useContext(PreviewFile)
  const path = src && file ? markdownImagePath(src, file.filePath) : null
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!path || !file) return
    let objectUrl: string | null = null
    let live = true
    setUrl(null)
    const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
    fsClient(file.workspaceId).readBinary(path).then((bytes) => {
      if (!live) return
      objectUrl = URL.createObjectURL(new Blob([bytes.slice()], { type }))
      setUrl(objectUrl)
    }, () => {})
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, file])
  const shown = path ? url : src
  return shown ? <img src={shown} alt={alt ?? ''} className="max-w-full rounded-md my-2" /> : <span className="text-muted">{alt}</span>
}

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
  img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
}

export function MarkdownPreview({ content, workspaceId, filePath }: { content: string; workspaceId: string; filePath: string }) {
  const file = useMemo(() => ({ workspaceId, filePath }), [workspaceId, filePath])
  return (
    <div className="absolute inset-0 overflow-auto px-6 py-4" data-testid="markdown-preview">
      <div className="max-w-3xl mx-auto prose-markdown space-y-3 [&>:first-child]:mt-0 text-[13px] text-primary leading-relaxed">
        <PreviewFile.Provider value={file}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
        </PreviewFile.Provider>
      </div>
    </div>
  )
}
