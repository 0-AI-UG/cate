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
  const queue = useUrlPromptStore((s) => s.promptsByPanel[panelId])
  const accept = useUrlPromptStore((s) => s.accept)
  const dismiss = useUrlPromptStore((s) => s.dismiss)

  if (!queue || queue.length === 0) return null
  const prompt = queue[0]
  const remaining = queue.length - 1

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-3 border-t border-subtle shrink-0 text-[12px]">
      <span className="text-secondary shrink-0">Open</span>
      <span
        className="flex-1 min-w-0 truncate text-primary font-mono"
        title={prompt.url}
      >
        {prompt.url}
      </span>
      {remaining > 0 && (
        <span className="shrink-0 text-secondary tabular-nums">+{remaining}</span>
      )}
      <button
        onClick={() => accept(panelId)}
        className="px-3 py-1 rounded-full leading-none bg-focus-blue text-inverse font-medium hover:opacity-90 transition-opacity"
      >
        Open
      </button>
      <button
        onClick={() => dismiss(panelId)}
        className="px-3 py-1 rounded-full leading-none text-secondary hover:text-primary hover:bg-hover transition-colors"
      >
        Dismiss
      </button>
    </div>
  )
}
