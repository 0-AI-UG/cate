// Turn an unknown error into a clean, human-readable string fit for the UI.
// Electron prefixes rejected ipcRenderer.invoke calls with this wrapper.
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/
const ERROR_NAME_PREFIX = /^(?:[A-Z][a-zA-Z]*Error|Error):\s*/

const FRIENDLY: ReadonlyArray<{ match: RegExp; message: string }> = [
  { match: /rejected[\s\S]*non-fast-forward|non-fast-forward[\s\S]*failed to push some refs/i, message: 'The remote branch has newer commits. Update this worktree, then try publishing again.' },
  { match: /diverging branches[\s\S]*fast-forward|not possible to fast-forward/i, message: 'That branch already exists locally and has diverged. Preserve or rename it, then try again.' },
  { match: /a branch named .* already exists/i, message: 'A branch with that name already exists.' },
  { match: /not a valid branch name|invalid branch name/i, message: 'That isn’t a valid Git branch name.' },
  { match: /not a valid object name|unknown revision|invalid reference|not a commit/i, message: 'The selected base branch no longer exists.' },
  { match: /authentication failed|not authenticated|could not read Username|permission denied.*publickey|HTTP 401|HTTP 403/i, message: 'GitHub rejected the operation. Check your authentication and repository access.' },
  { match: /does not appear to be a git repository|no configured push destination|no such remote/i, message: 'This repository doesn’t have a usable remote.' },
  { match: /No runtime registered for id/i, message: 'The runtime isn’t connected on this host yet. Install it and try again.' },
  { match: /ENOENT|no such file or directory/i, message: 'That file or folder no longer exists.' },
  { match: /EACCES|permission denied/i, message: 'Permission denied.' },
  { match: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|socket hang up/i, message: 'Couldn’t reach the host. Check your connection and try again.' },
]

function rawMessage(error: unknown): string {
  if (error == null) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

function unwrap(message: string): string {
  let output = message.replace(IPC_WRAPPER, '').trim()
  let previous: string
  do {
    previous = output
    output = output.replace(ERROR_NAME_PREFIX, '').trim()
  } while (output !== previous)
  return output
}

export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  const cleaned = unwrap(rawMessage(error))
  if (!cleaned) return fallback
  if (/^(?:SSH |The system OpenSSH )/.test(cleaned)) return cleaned
  for (const friendly of FRIENDLY) {
    if (friendly.match.test(cleaned)) return friendly.message
  }
  return cleaned
}
