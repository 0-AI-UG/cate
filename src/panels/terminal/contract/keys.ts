// Friendly key names for `cate terminal press`, as the byte sequences a
// terminal expects. Beyond the closed list, ctrl-<letter> chords are computed
// (ctrl-c is \x03). The bytes go to whatever runs in the terminal: a
// foreground TUI receives them, not the shell.

const PRESS_KEYS: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
}

/** The sequence for one key name (case-insensitive), or null when unknown. */
export function sequenceForKey(raw: string): string | null {
  const key = raw.toLowerCase()
  const direct = PRESS_KEYS[key]
  if (direct !== undefined) return direct
  const ctrl = /^ctrl[-+]([a-z])$/.exec(key)
  return ctrl ? String.fromCharCode(ctrl[1].charCodeAt(0) - 96) : null
}

/** Space-separated key names as one sequence; `unknown` names the first key
 *  that has none. */
export function sequenceForKeys(raw: string): { data: string } | { unknown: string } {
  let data = ''
  for (const key of raw.trim().split(/\s+/).filter(Boolean)) {
    const seq = sequenceForKey(key)
    if (seq === null) return { unknown: key }
    data += seq
  }
  return { data }
}
