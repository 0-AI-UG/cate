// `cate.terminal.*`: handled by the terminal panel's session. Input verbs never
// resolve an implicit target beyond the sticky one: a misresolved read is
// noise, a misresolved keystroke runs in the wrong shell.

import { defineCateApi, defineCliArea, num, opt, str } from '@kernel/api/contract'

/** The CLI permission area of these methods. */
export const terminalCliArea = defineCliArea({
  label: 'Terminal',
  read: {
    key: 'cliTerminalReadEnabled',
    code: 'terminal-read-disabled',
    detail:
      '`cate terminal read`: read the screen and scrollback of terminal panels, which may contain secrets printed there.',
  },
  control: {
    key: 'cliTerminalInputEnabled',
    code: 'terminal-input-disabled',
    detail:
      '`cate terminal type / press`: send keystrokes to terminal panels; input goes to whatever runs there, including your shell.',
  },
})

export const terminalApi = defineCateApi(
  'terminal',
  {
    read: {
      access: 'read',
      handler: 'session',
      summary: 'Print the rendered screen and scrollback',
      args: {
        lines: opt(num.int().min(1)).help('Print only the last <lines> lines'),
      },
      format: 'terminalText',
    },
    type: {
      access: 'control',
      handler: 'session',
      target: 'sticky',
      summary: 'Type text into the terminal (no Enter is appended)',
      args: { text: str.rest('text').help('Text to type (no Enter)') },
    },
    press: {
      access: 'control',
      handler: 'session',
      target: 'sticky',
      summary: 'Press keys: enter, tab, escape, backspace, space, arrows, pageup/pagedown, home, end, ctrl-<letter>',
      args: { keys: str.nonEmpty().rest('key').help('Key names, pressed in order') },
    },
  },
  { area: terminalCliArea, summary: 'Read terminal panels and send them text and keys' },
)
