// =============================================================================
// Ask routing — send a prompt into a target terminal's PTY, wait for output to
// settle, capture the response.
//
// Orchestration model
// -------------------
// 1. WAIT FOR IDLE. Before sending we observe the target for `preQuietMs` of
//    silence (default 600 ms). If the agent is mid-response, the prompt would
//    just queue in Claude Code's input box ("2 new messages (ctrl+End)") and
//    never get processed cleanly. We block until the target is genuinely
//    idle, or `preMaxWaitMs` (default 90 s) — after which we send anyway and
//    let it queue (with a warning in the response prefix).
// 2. SEND AS BRACKETED PASTE. Modern TUIs (Claude Code, Codex, Gemini CLI,
//    opencode) all enable bracketed-paste mode and DO want the prompt body
//    wrapped in `\x1b[200~ ... \x1b[201~`. The earlier "disable bracketed
//    paste, type the body" trick caused visual mangling because Claude
//    Code's input renderer relied on the markers. The trailing `\r` we send
//    AFTER the paste-end is therefore a real Enter keystroke — submit.
// 3. CAPTURE TO SETTLING. Subscribe to live PTY data; capture stops after
//    `settlingMs` (default 2 s) of silence, ANSI-stripped and trimmed.
// 4. MULTIPLE ECHO-OUT FILTER. The first chunks usually contain the echoed
//    prompt (Claude Code re-renders the input box with our text). We strip
//    that prefix from the captured response by matching against the prompt.
//
// Concurrency: per-target single-flight via `inFlight`. Concurrent calls to
// the same target reject immediately with BUSY rather than queuing.
// =============================================================================

import { subscribe } from './dataTap'
import { stripAnsi, dedupeRedraws } from './dataTap'
import { writePty } from './ptyBridge'
import { broadcastInFlight } from './graphSync'

const DEFAULT_SETTLING_MS = 2000
const DEFAULT_MAX_WAIT_MS = 600000
const DEFAULT_PRE_QUIET_MS = 600
const DEFAULT_PRE_MAX_WAIT_MS = 90000

const inFlight = new Set<string>()

export interface AskOptions {
  settlingMs?: number
  maxWaitMs?: number
  /** How long the target must be silent before we send (ms). */
  preQuietMs?: number
  /** How long we'll wait for the target to go idle before giving up (ms). */
  preMaxWaitMs?: number
  /** Canvas node ids for in-flight UI highlighting. Optional. */
  callerNodeId?: string | null
  targetNodeId?: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Replace embedded CR/LF in a single-line prompt with spaces so the agent
 *  sees ONE logical input. Bracketed-paste content with literal newlines
 *  would still get split into multiple input lines by Claude Code. */
function flattenPrompt(p: string): string {
  return p.replace(/\r\n|\r|\n/g, ' ').trim()
}

/** Wait for the target PTY to produce no output for `quietMs` consecutive
 *  milliseconds. Caps at `maxMs`. Resolves with true if quiet was reached,
 *  false if the cap fired first. */
function waitForIdle(ptyId: string, quietMs: number, maxMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let quietTimer: NodeJS.Timeout
    let hardTimer: NodeJS.Timeout

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(quietTimer)
      clearTimeout(hardTimer)
      unsub()
      resolve(ok)
    }

    const arm = () => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(true), quietMs)
    }

    const unsub = subscribe(ptyId, () => arm())
    arm()
    hardTimer = setTimeout(() => finish(false), maxMs)
  })
}

/** Send the prompt to a target PTY in a way that ALWAYS triggers a submit on
 *  TUIs like Claude Code, Codex, Gemini CLI, opencode.
 *
 *  Why we don't use bracketed paste any more:
 *    Even with paste-end + delay + `\r`, Claude Code's paste-finalisation
 *    window can absorb the trailing CR into the paste content — the user
 *    sees the prompt sitting in the input box, no submit fires, and they
 *    have to hit Enter themselves. ("prompts get stuck at the end.")
 *
 *  What we do instead:
 *    1. Clear any pending input (Ctrl-U).
 *    2. Drip the body in tiny chunks with small delays so it looks like
 *       keyboard input rather than a paste. Most TUIs only switch into
 *       paste-mode handling when they see the explicit \x1b[200~ marker,
 *       so plain bytes coming in at typing speed get routed through the
 *       same code path as a user typing — every char goes straight into
 *       the input buffer.
 *    3. Wait for the TUI to finish rendering the typed input.
 *    4. Send \r as a discrete write — this is unambiguously the Enter
 *       keypress in raw-mode TUIs and triggers submit.
 *
 *  Total cost for a 1 KB prompt ≈ 700 ms typing time + 150 ms tail. Worth
 *  the latency for reliable submit semantics across every supported agent. */
async function submitPrompt(ptyId: string, prompt: string): Promise<void> {
  const body = flattenPrompt(prompt)

  // 1. Clear any input the user (or a stuck previous ask) might have left
  //    sitting on the prompt line.
  writePty(ptyId, '\x15')
  await sleep(40)

  // 2. Drip-feed the body. Small chunks + small inter-write delay defeats
  //    any timing-based paste detection a TUI might run.
  const CHUNK = 16
  for (let i = 0; i < body.length; i += CHUNK) {
    writePty(ptyId, body.slice(i, i + CHUNK))
    await sleep(8)
  }

  // 3. Let the TUI's input box finish rendering everything we just typed.
  await sleep(150)

  // 4. Submit. Single CR — \n on top would queue an empty second submit
  //    in agents that treat them as separate keystrokes.
  writePty(ptyId, '\r')
}

export async function askTerminal(targetPtyId: string, prompt: string, opts: AskOptions = {}): Promise<string> {
  if (inFlight.has(targetPtyId)) {
    const err: any = new Error('target terminal is already handling another ask')
    err.code = 'BUSY'
    throw err
  }
  inFlight.add(targetPtyId)

  const settlingMs = opts.settlingMs ?? DEFAULT_SETTLING_MS
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const preQuietMs = opts.preQuietMs ?? DEFAULT_PRE_QUIET_MS
  const preMaxWaitMs = opts.preMaxWaitMs ?? DEFAULT_PRE_MAX_WAIT_MS

  // Highlight the connection while an ask is in flight (visual feedback).
  if (opts.callerNodeId && opts.targetNodeId) {
    broadcastInFlight(opts.callerNodeId, opts.targetNodeId, true)
  }

  // Phase 1: wait for the target to be quiet before sending. Otherwise our
  // prompt lands while it's busy and Claude Code queues it as a pending
  // message ("X new messages (ctrl+End)") which never auto-processes cleanly.
  await waitForIdle(targetPtyId, preQuietMs, preMaxWaitMs)

  // Phase 2: subscribe for the response capture window, then submit.
  return new Promise<string>((resolve, reject) => {
    let captured = ''
    let settleTimer: NodeJS.Timeout | null = null
    let maxTimer: NodeJS.Timeout | null = null
    let receivedAny = false

    const finish = (err?: Error) => {
      if (settleTimer) clearTimeout(settleTimer)
      if (maxTimer) clearTimeout(maxTimer)
      unsubscribe()
      inFlight.delete(targetPtyId)
      if (opts.callerNodeId && opts.targetNodeId) {
        broadcastInFlight(opts.callerNodeId, opts.targetNodeId, false)
      }
      if (err) reject(err)
      else resolve(cleanResponse(captured, prompt))
    }

    const armSettling = () => {
      if (settleTimer) clearTimeout(settleTimer)
      // Use a longer initial wait (until we see ANY output) and a shorter
      // post-output settling. This lets slow-starting agents (like Claude
      // Code spinning up a tool) not get a premature settle, while keeping
      // total latency low once chunks start flowing.
      const ms = receivedAny ? settlingMs : Math.max(settlingMs * 2, 5000)
      settleTimer = setTimeout(() => finish(), ms)
    }

    const unsubscribe = subscribe(targetPtyId, (chunk: string) => {
      captured += chunk
      if (chunk.length > 0) receivedAny = true
      armSettling()
    })

    maxTimer = setTimeout(() => {
      const err: any = new Error(`ask timed out after ${maxWaitMs}ms (no settle)`)
      err.code = 'TIMEOUT'
      finish(err)
    }, maxWaitMs)

    submitPrompt(targetPtyId, prompt).catch((e: any) => {
      finish(new Error(`failed to write to target PTY: ${e?.message ?? e}`))
    })

    armSettling()
  })
}

// -----------------------------------------------------------------------------
// Response cleanup — strip the echoed prompt, TUI chrome, and trailing prompt
// line. Best-effort; full TUI screen-scraping would need a terminal emulator.
// -----------------------------------------------------------------------------

function cleanResponse(raw: string, prompt: string): string {
  let text = dedupeRedraws(stripAnsi(raw))
  // If the agent re-echoed our prompt verbatim, drop the first occurrence so
  // the caller doesn't get their own text back as part of the reply. Try the
  // flattened single-line form first (what we actually sent), then the first
  // 80 chars of the original (for tools that wrap at width).
  const flat = prompt.replace(/\r\n|\r|\n/g, ' ').trim()
  for (const needle of [flat, flat.slice(0, 80)]) {
    if (!needle) continue
    const idx = text.indexOf(needle)
    if (idx >= 0) { text = text.slice(idx + needle.length); break }
  }
  // Strip trailing TUI chrome: empty lines, lone `>` prompts, Claude Code's
  // status footer ("auto mode on (shift+tab to cycle)"), and "Try …" hints.
  const lines = text.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim()
    if (
      last === '' ||
      last === '>' ||
      last === '›' ||                            // single-arrow prompt
      /^auto mode on\b/i.test(last) ||
      /^shift\+tab to cycle\b/i.test(last) ||
      /^try /i.test(last) ||
      /^\(esc to interrupt\)$/i.test(last) ||
      /^\d+ new messages?\b/i.test(last) ||
      /^[│┃|]+$/.test(last)                       // trailing TUI border bars
    ) {
      lines.pop()
      continue
    }
    break
  }
  text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text
}
