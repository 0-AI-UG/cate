// =============================================================================
// agentDrop — pure helper to format dropped file paths as chat @-mentions.
// A search-line drag carries a line number, mentioned as @path:line.
// Unit-testable.
// =============================================================================

export interface LineRef {
  path?: string
  line?: number
}

export function buildFileMentions(paths: string[], lineRef: LineRef | null): string {
  return paths
    .map((p) => (lineRef?.path === p && lineRef.line ? `@${p}:${lineRef.line}` : `@${p}`))
    .join(' ')
}
