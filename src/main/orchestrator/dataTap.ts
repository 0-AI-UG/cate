// =============================================================================
// PTY data tap — keeps a per-terminal ring buffer of recent output, and lets
// orchestrator commands subscribe to live chunks for the duration of an `ask`.
//
// Cate's existing TerminalLogger writes raw PTY output to disk for session
// restore; this tap is the in-memory complement, used by:
//   - `cate check` (Phase A) to return recent scrollback ANSI-stripped
//   - `cate ask`   (Phase C) to capture a target terminal's reply
// =============================================================================

const RING_BYTES = 64 * 1024 // 64 KB per terminal

interface Ring {
  buf: string[]      // chunks
  size: number       // total chars
}

const rings = new Map<string, Ring>()

type Subscriber = (chunk: string) => void
const subs = new Map<string, Set<Subscriber>>()

export function tap(ptyId: string, data: string): void {
  let ring = rings.get(ptyId)
  if (!ring) {
    ring = { buf: [], size: 0 }
    rings.set(ptyId, ring)
  }
  ring.buf.push(data)
  ring.size += data.length
  while (ring.size > RING_BYTES && ring.buf.length > 1) {
    const removed = ring.buf.shift()!
    ring.size -= removed.length
  }

  const set = subs.get(ptyId)
  if (set && set.size > 0) {
    for (const s of set) {
      try { s(data) } catch { /* subscriber errors must not affect PTY flow */ }
    }
  }
}

/** Read the current ring buffer for a terminal (raw PTY output, ANSI included). */
export function readRing(ptyId: string): string {
  return rings.get(ptyId)?.buf.join('') ?? ''
}

/** Subscribe to live PTY output. Returns an unsubscribe function. */
export function subscribe(ptyId: string, fn: Subscriber): () => void {
  let set = subs.get(ptyId)
  if (!set) {
    set = new Set()
    subs.set(ptyId, set)
  }
  set.add(fn)
  return () => {
    const s = subs.get(ptyId)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) subs.delete(ptyId)
  }
}

/** Drop ring + subscribers for a terminal that has exited. */
export function disposeTerminal(ptyId: string): void {
  rings.delete(ptyId)
  subs.delete(ptyId)
}

// -----------------------------------------------------------------------------
// ANSI stripping — for `cate check` / `cate ask` output. Removes CSI sequences,
// OSC sequences (e.g. terminal title), and a handful of common single-char
// escapes. Good enough for human display; not a complete terminal emulator.
// -----------------------------------------------------------------------------

const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g
const ANSI_OTHER = /\x1B[PX^_].*?\x1B\\/g
const ANSI_SIMPLE = /\x1B[()][A-Z0-9]/g
// Bracketed-paste markers leak into the stream when the agent echoes our
// submit — strip them in the cleanup pass.
const BRACKETED_PASTE = /\x1B\[200~|\x1B\[201~/g
// Box-drawing characters and Powerline glyphs left over from TUI redraws —
// keep them, they're meaningful, but we collapse runs of pure-whitespace
// lines that TUIs use for layout padding.

export function stripAnsi(s: string): string {
  return s
    .replace(BRACKETED_PASTE, '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_OTHER, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_SIMPLE, '')
    // Carriage returns mid-stream usually mean "redraw this line" — collapse
    // to a single newline so the output doesn't look like one giant smudged line.
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Drop other C0 control chars except tab/newline.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

/** Collapse consecutive duplicate lines (often produced by TUI redraws of
 *  the same prompt line as Claude updates its spinner/timer). Trims trailing
 *  whitespace per line so duplicate-detection isn't fooled by spinner padding. */
export function dedupeRedraws(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''))
  const out: string[] = []
  for (const l of lines) {
    if (out.length > 0 && out[out.length - 1] === l) continue
    out.push(l)
  }
  return out.join('\n')
}

/** Return the last N lines of a terminal's ring, ANSI-stripped and with
 *  TUI redraw artifacts collapsed. */
export function tailLines(ptyId: string, lines: number): string {
  const raw = readRing(ptyId)
  const clean = dedupeRedraws(stripAnsi(raw))
  const arr = clean.split('\n')
  if (arr.length <= lines) return clean
  return arr.slice(arr.length - lines).join('\n')
}
