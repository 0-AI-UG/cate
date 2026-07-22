// =============================================================================
// cateAgentContextRegistry — the single home for live Cate Agent session contexts,
// keyed by panelId. The bridge resolves a session's context from here (contextFor),
// the controller registers/clears its observer/orchestrator sessions, and the
// launcher registers its per-iteration driver sessions. Kept in a leaf module so
// the controller and the tools/launcher can both touch it without importing each
// other (no cycle).
//
// It ALSO owns the terminalId -> owning driver-session map: when a driver's
// `create_terminal` opens a terminal, the launcher records who owns it, so a later
// `running -> finished` transition on that terminal re-prompts the correct driver
// (the backgrounded-send_keys wake in codingAgentLauncher).
// =============================================================================

import type { CateAgentContext } from './cateAgentTypes'

const ctxByPanel = new Map<string, CateAgentContext>()
/** terminal panelId -> the driver session panelId that created it. */
const driverByTerminal = new Map<string, string>()

export function setContext(panelId: string, ctx: CateAgentContext): void {
  ctxByPanel.set(panelId, ctx)
}

export function getContext(panelId: string): CateAgentContext | null {
  return ctxByPanel.get(panelId) ?? null
}

export function deleteContext(panelId: string): void {
  ctxByPanel.delete(panelId)
}

export function hasContext(panelId: string): boolean {
  return ctxByPanel.has(panelId)
}

export function contextPanelIds(): string[] {
  return [...ctxByPanel.keys()]
}

// --- terminalId -> owning driver session ------------------------------------

export function setTerminalOwner(terminalId: string, driverPanelId: string): void {
  driverByTerminal.set(terminalId, driverPanelId)
}

export function terminalOwner(terminalId: string): string | undefined {
  return driverByTerminal.get(terminalId)
}

/** Every terminal a driver session created (so it can be torn down with it). */
export function terminalsOwnedBy(driverPanelId: string): string[] {
  const out: string[] = []
  for (const [terminalId, owner] of driverByTerminal) if (owner === driverPanelId) out.push(terminalId)
  return out
}

export function clearTerminalOwner(terminalId: string): void {
  driverByTerminal.delete(terminalId)
}
