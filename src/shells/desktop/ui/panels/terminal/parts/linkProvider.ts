// The terminal's links for xterm: one link provider that asks the runtime
// for the links on the hovered row (`process.links`: URLs and existing files
// in the output, also where they wrap), and the `linkHandler` for OSC 8
// hyperlinks. Every click goes to `open`.

import type { IBufferRange, ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm'
import { osc8Target, type TerminalLink, type TerminalLinkTarget } from '@services/terminal/contract'

export interface LinkPorts {
  /** The runtime's links on a row (counted up from the last line) showing
   *  `text`; none without a live PTY. */
  links(row: number, text: string): Promise<TerminalLink[]>
  /** `external`: the person asked for the system browser. */
  open(target: TerminalLinkTarget, external: boolean): void
}

export interface LinkTerminal {
  readonly buffer: {
    readonly active: {
      readonly length: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}

/**
 * What a click on a link does, as in VS Code: the platform's primary
 * modifier (Cmd on mac, Ctrl elsewhere) opens it; adding Shift opens a web
 * link in the system browser. A plain click does nothing, so selecting text
 * never opens anything.
 */
export function linkClick(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, isMac: boolean): 'open' | 'external' | null {
  if (!(isMac ? e.metaKey : e.ctrlKey)) return null
  return e.shiftKey ? 'external' : 'open'
}

export function createLinkProvider(terminal: LinkTerminal, ports: LinkPorts, isMac: boolean): ILinkProvider {
  const activate = (target: TerminalLinkTarget) => (event: MouseEvent) => {
    const click = linkClick(event, isMac)
    if (click) ports.open(target, click === 'external')
  }

  return {
    provideLinks(y, callback) {
      const buffer = terminal.buffer.active
      const text = buffer.getLine(y - 1)?.translateToString(true) ?? ''
      if (!text.trim()) {
        callback(undefined)
        return
      }
      // The answer counts rows from the end of the buffer as it was asked.
      const length = buffer.length
      ports.links(length - y, text)
        .then((links) => {
          const shown = links.map(({ target, text, start, end }): ILink => ({
            range: { start: { x: start.x + 1, y: length - start.row }, end: { x: end.x, y: length - end.row } },
            text,
            activate: activate(target),
          }))
          callback(shown.length > 0 ? shown : undefined)
        })
        .catch(() => callback(undefined))
    },
  }
}

/** OSC 8 hyperlinks: the program names the target, so it is exact however
 *  the text wraps. Web and `file://` targets open; other schemes do not. */
export function createOsc8Handler(ports: Pick<LinkPorts, 'open'>, isMac: boolean): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate(event: MouseEvent, uri: string, _range: IBufferRange) {
      const click = linkClick(event, isMac)
      const target = click ? osc8Target(uri) : null
      if (target) ports.open(target, click === 'external')
    },
  }
}
