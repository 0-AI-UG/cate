// =============================================================================
// Terminal restore data — a neutral, dependency-free home for the session
// restore map so both session.ts (which populates it) and lighter modules like
// panelTransfer.ts (which seed replay entries for restored canvas children) can
// share it without importing the heavy session module and creating a cycle.
//
// Populated during restoreSession(); consumed by terminalRegistry.getOrCreate()
// and replayTerminalLog(). Re-exported from lib/workspace/session for back-compat.
// =============================================================================

export const terminalRestoreData = new Map<string, { cwd?: string; replayFromId?: string }>()
