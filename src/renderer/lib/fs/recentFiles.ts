// Session-only most-recently-opened file paths, per workspace. Lives in a plain
// module (no store, not persisted) — it just lets the command palette show
// something useful in its Files section when the search box is empty.

const MAX = 15
const byWorkspace = new Map<string, string[]>()

export function recordRecentFile(workspaceId: string, filePath: string): void {
  if (!workspaceId || !filePath) return
  const next = [filePath, ...(byWorkspace.get(workspaceId) ?? []).filter((p) => p !== filePath)]
  byWorkspace.set(workspaceId, next.slice(0, MAX))
}

export function getRecentFiles(workspaceId: string): string[] {
  return byWorkspace.get(workspaceId) ?? []
}
