// Extract the "interesting" segment from an OSC 0/1/2 title written by an
// agent CLI (Claude, Codex, etc.).
//
// Agents in iTerm/Terminal.app style typically set titles like:
//   "georgschrojahr — ✱ Test schroejahr.de aufrufen — bun ‹ claude — 133×24"
//   └── seg 0 ──┘   └─────── seg 1 (we want) ─────┘   └ seg 2 ┘   └ 3 ┘
//
// The first segment is usually the cwd / user, the third+ is the running
// process tree and tty size. Segment 1 carries the live status (spinner
// glyph + current task) which is what should show in the tab.
//
// Strategy: prefer segment[1] whenever the title is split at least once.
// With only 2 segments the second is still more useful than the cwd-only
// first (e.g. "cwd — claude" → "claude"). Falls back to the raw title when
// no em-dash delimiter is present at all — better to show too much than
// nothing.

const DELIMITER = ' — ' // U+2014 em-dash with surrounding spaces

export function extractAgentTitleSegment(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const segments = trimmed.split(DELIMITER)
  if (segments.length >= 2) {
    const middle = segments[1].trim()
    if (middle) return middle
  }
  return trimmed
}

// A plain shell with no detected agent lets its OSC title drive the tab name.
// On macOS/Linux that title is usually just the folder name, but Windows shells
// (PowerShell, cmd) set it to the full working directory — "C:\Users\foo\proj" —
// which makes the tab show the entire path. Collapse a bare absolute path to its
// final segment so Windows matches the POSIX behavior; anything that isn't an
// absolute path (agent status lines, custom titles) is returned untouched.
const ABSOLUTE_PATH_PREFIX = /^([a-zA-Z]:[\\/]|\\\\|\/)/

export function shellTitleBasename(title: string): string {
  const trimmed = title.trim()
  if (!ABSOLUTE_PATH_PREFIX.test(trimmed)) return title
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? title
}
