// =============================================================================
// TerminalUrlPrompt — inline strip rendered at the bottom of a TerminalPanel
// when a URL was detected in its output and the "URLs from terminal" setting
// is set to 'prompt'. Sits inside the terminal panel (not a global toast) so
// the confirmation is anchored to the terminal that produced the URL.
// =============================================================================

import { useUrlPromptStore } from '../stores/urlPromptStore'

interface Props {
  panelId: string
}

export function TerminalUrlPrompt({ panelId }: Props) {
  const prompt = useUrlPromptStore((s) => s.promptsByPanel[panelId])
  const accept = useUrlPromptStore((s) => s.accept)
  const dismiss = useUrlPromptStore((s) => s.dismiss)

  if (!prompt) return null

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-3 border-t border-subtle shrink-0 text-[12px]">
      <span className="text-secondary shrink-0">Open</span>
      <span
        className="flex-1 min-w-0 truncate text-primary font-mono"
        title={prompt.url}
      >
        {prompt.url}
      </span>
      <button
        onClick={() => accept(panelId)}
        className="px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
      >
        Open
      </button>
      <button
        onClick={() => dismiss(panelId)}
        className="px-2 py-0.5 rounded text-secondary hover:text-primary hover:bg-hover transition-colors"
      >
        Dismiss
      </button>
    </div>
  )
}
