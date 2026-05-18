// =============================================================================
// PTY bridge — thin indirection so the orchestrator doesn't import the
// terminal module directly (which would create an import cycle: terminal.ts
// taps the orchestrator, orchestrator writes back into terminal.ts).
//
// The terminal IPC module calls `setWriter()` at boot to register its write
// function; the orchestrator calls `writePty()` to send bytes back.
// =============================================================================

type Writer = (id: string, data: string) => void

let writer: Writer | null = null

export function setWriter(fn: Writer): void {
  writer = fn
}

export function writePty(id: string, data: string): void {
  if (!writer) throw new Error('orchestrator: PTY writer not registered')
  writer(id, data)
}
