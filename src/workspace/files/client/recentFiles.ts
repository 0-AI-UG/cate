// Recently opened files per workspace, in memory for this client only; the
// quick finder shows them when its query is empty.

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
