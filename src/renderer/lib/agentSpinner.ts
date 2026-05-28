// Detect whether an agent CLI is actively working from its OSC window title.
//
// The dominant convention — Claude Code, Codex, and most Ink/Rust TUIs that
// use the cli-spinners "dots" set — animates a Unicode braille glyph as the
// first character of the title while a turn is in flight. When the agent is
// idle it shows a static marker instead (Claude "✳"/"✱", Codex the bare
// project name). So: a leading braille-pattern glyph means "running"; anything
// else (or no title) means "idle / awaiting input".
//
// Verified empirically against `claude` and `codex`; applies to any agent that
// animates a braille spinner in its title.

const BRAILLE_PATTERN_START = 0x2800
const BRAILLE_PATTERN_END = 0x28ff

export function titleIndicatesRunning(titleSegment: string): boolean {
  const s = titleSegment.replace(/^\s+/, '')
  if (!s) return false
  const cp = s.codePointAt(0)
  return cp != null && cp >= BRAILLE_PATTERN_START && cp <= BRAILLE_PATTERN_END
}

// Some agents keep a static OSC title and instead animate their spinner in the
// terminal BODY. Detect a body spinner glyph anywhere in a PTY output chunk,
// AFTER stripping OSC sequences so a title spinner (claude/codex) isn't counted
// here — those are handled by titleIndicatesRunning on the parsed title and
// must stay purely title-driven.
//
// Body spinner glyphs:
//   - braille block U+2800–U+28FF — pi's "⠋ Working…" line (and the common
//     cli-spinners "dots" set).
//   - U+2B1D (⬝) — OpenCode's block scanner bar (its inactive cell). This is
//     the one glyph unique to OpenCode's working animation: its progress bars
//     use ■ (U+25A0) and message headers use ▣ (U+25A3), so matching only ⬝
//     stays idle-safe (verified: present every working frame, absent at idle).
const OSC_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
const BODY_SPINNER_GLYPH = /[⠀-⣿⬝]/

export function outputShowsBodySpinner(chunk: string): boolean {
  return BODY_SPINNER_GLYPH.test(chunk.replace(OSC_SEQUENCE, ''))
}
