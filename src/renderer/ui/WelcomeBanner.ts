// =============================================================================
// Welcome banner — ported from CanvasIDEApp.swift WelcomeBanner enum
// Generates ANSI-colored ASCII art for display in xterm.js terminals.
// =============================================================================

const ESC = '\x1b'
const CYAN = `${ESC}[1;36m`
const GRAY = `${ESC}[0;90m`
const BOLD = `${ESC}[1;37m`
const RESET = `${ESC}[0m`

/**
 * Generate the CanvasIDE welcome banner as an ANSI-escaped string.
 * Write the returned string directly to an xterm.js Terminal instance.
 */
export function generateWelcomeBanner(): string {
  const lines = [
    '',
    `${CYAN}     \u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557${RESET}`,
    `${CYAN}    \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D${RESET}`,
    `${CYAN}    \u2588\u2588\u2551      \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2588\u2588\u2588\u2557  ${RESET}`,
    `${CYAN}    \u2588\u2588\u2551      \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2554\u2550\u2550\u255D  ${RESET}`,
    `${CYAN}    \u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2551  \u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557${RESET}`,
    `${CYAN}     \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D  \u255A\u2550\u255D   \u255A\u2550\u255D   \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}`,
    '',
    `${GRAY}            Canvas Terminal${RESET}`,
    '',
    `  ${BOLD}\u2318T${GRAY}  New Terminal     ${BOLD}\u2318\u21E7B${GRAY}  New Browser${RESET}`,
    `  ${BOLD}\u2318\u21E7E${GRAY} New Editor       ${BOLD}\u2318K${GRAY}   Command Palette${RESET}`,
    `  ${BOLD}\u2318\\${GRAY}  Toggle Sidebar   ${BOLD}\u23180${GRAY}   Reset Zoom${RESET}`,
    '',
  ]

  // xterm.js uses \r\n for newlines
  return lines.join('\r\n')
}

/**
 * Shell command to clear the terminal after the banner has been displayed.
 */
export function welcomeCommand(): string {
  return 'clear'
}
