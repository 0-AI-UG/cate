// =============================================================================
// errorMessage — turn an unknown thrown value into a clean, human-readable
// string fit for the UI.
//
// Errors that cross Electron's IPC boundary arrive wrapped:
//   "Error invoking remote method 'git:init': Error: No runtime registered…"
// and internal errors often carry jargon the user can't act on. This strips the
// IPC plumbing and maps known technical messages to friendly equivalents so we
// never surface raw errors like that screenshot again.
// =============================================================================

// Electron prefixes every rejected ipcRenderer.invoke with this.
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/
// Leading "Error:" / "TypeError:" / "Error Error:" left over after unwrapping.
const ERROR_NAME_PREFIX = /^(?:[A-Z][a-zA-Z]*Error|Error):\s*/

// Known internal messages → what the user should actually read. Matched against
// the cleaned message; first hit wins.
const FRIENDLY: ReadonlyArray<{ match: RegExp; message: string }> = [
  {
    match: /rejected[\s\S]*non-fast-forward|non-fast-forward[\s\S]*failed to push some refs/i,
    message: 'The remote branch has newer commits. Update this worktree, then try publishing again.',
  },
  {
    match: /diverging branches[\s\S]*fast-forward|not possible to fast-forward/i,
    message: 'That branch already exists locally and has diverged. Preserve or rename it, then try again.',
  },
  {
    match: /a branch named .* already exists/i,
    message: 'A branch with that name already exists.',
  },
  {
    match: /not a valid branch name|invalid branch name/i,
    message: 'That isn’t a valid Git branch name.',
  },
  {
    match: /not a valid object name|unknown revision|invalid reference|not a commit/i,
    message: 'The selected base branch no longer exists.',
  },
  {
    match: /authentication failed|not authenticated|could not read Username|permission denied.*publickey|HTTP 401|HTTP 403/i,
    message: 'GitHub rejected the operation. Check your authentication and repository access.',
  },
  {
    match: /does not appear to be a git repository|no configured push destination|no such remote/i,
    message: 'This repository doesn’t have a usable remote.',
  },
  {
    match: /No runtime registered for id/i,
    message: 'The runtime isn’t connected on this host yet. Install it and try again.',
  },
  {
    match: /ENOENT|no such file or directory/i,
    message: 'That file or folder no longer exists.',
  },
  {
    match: /EACCES|permission denied/i,
    message: 'Permission denied.',
  },
  {
    match: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|socket hang up/i,
    message: 'Couldn’t reach the host. Check your connection and try again.',
  },
]

/** Pull a raw message string out of any thrown value. */
function rawMessage(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
    return (err as any).message
  }
  return String(err)
}

/** Strip Electron IPC wrapping and any leftover "Error:" name prefixes. */
function unwrap(message: string): string {
  let out = message.replace(IPC_WRAPPER, '').trim()
  // Unwrapping the IPC layer can expose a stacked "Error: Error: …"; peel each.
  let prev: string
  do {
    prev = out
    out = out.replace(ERROR_NAME_PREFIX, '').trim()
  } while (out !== prev)
  return out
}

/**
 * Format an unknown error for display. Strips IPC noise, maps known technical
 * errors to friendly text, and falls back to the cleaned message. Pass
 * `fallback` for the empty / unrecognised case.
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  const cleaned = unwrap(rawMessage(err))
  if (!cleaned) return fallback
  for (const { match, message } of FRIENDLY) {
    if (match.test(cleaned)) return message
  }
  return cleaned
}
