// =============================================================================
// terminalDrop — pure helper for formatting dropped file references into text
// pasted at the terminal prompt. A search-line drag carries a line number,
// rendered as path:line (a VS Code-style reference). Unit-testable.
// =============================================================================

export interface DroppedRef {
  path: string
  /** 1-based line for a search-line drag; omitted for plain file drags. */
  line?: number
}

/** Shell-escape a single path (or path:line) for safe pasting. */
function shellEscape(p: string): string {
  if (/^[a-zA-Z0-9_./:@~=-]+$/.test(p)) return p
  return "'" + p.replace(/'/g, "'\\''") + "'"
}

/** Join dropped refs into a space-separated, shell-escaped string. */
export function formatTerminalPaste(refs: DroppedRef[]): string {
  return refs
    .map((r) => shellEscape(r.line ? `${r.path}:${r.line}` : r.path))
    .join(' ')
}
