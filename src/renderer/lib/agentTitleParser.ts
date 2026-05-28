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
