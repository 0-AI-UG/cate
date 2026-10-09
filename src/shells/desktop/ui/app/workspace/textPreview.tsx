// Read-only text previews (the relation toggle's "Preview sent context"):
// a modal over the window with the text and a copy button. Nothing is
// written to the workspace.

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Modal } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'

interface TextPreviewRequest {
  title: string
  content: string
}

function TextPreview({ title, content, onClose }: TextPreviewRequest & { onClose(): void }) {
  const [copied, setCopied] = useState(false)
  const copy = clientUi().writeClipboard
  return (
    <Modal
      title={title}
      onClose={onClose}
      width="min(760px, 90vw)"
      height="min(640px, 80vh)"
      headerActions={copy && (
        <Button size="sm" variant="ghost" onClick={() => { void copy(content); setCopied(true) }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      )}
    >
      <pre data-testid="text-preview" className="m-0 whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-5 text-primary select-text">
        {content}
      </pre>
    </Modal>
  )
}

/** Shows the preview; resolves once it is closed. */
export function openTextPreview(request: TextPreviewRequest): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  return new Promise((resolve) => {
    const close = () => {
      root.unmount()
      host.remove()
      resolve()
    }
    root.render(<TextPreview title={request.title} content={request.content} onClose={close} />)
  })
}
