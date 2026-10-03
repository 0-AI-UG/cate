// xterm link provider for file paths in terminal output (`src/foo.ts:12:5`).
// Candidates are checked against the workspace's files before they become
// links; Cmd/Ctrl+click opens the file at its line.

import type { ILink, ILinkProvider } from '@xterm/xterm'
import { isTerminalLinkModifier, parseTerminalFileMatches, resolveCandidatePath } from './fileLinks'

export interface FileLinkTerminal {
  readonly buffer: { readonly active: { getLine(y: number): { translateToString(trim?: boolean): string } | undefined } }
}

export interface FileLinkPorts {
  /** Relative paths resolve against this (the terminal's cwd, else the root). */
  base(): string
  isFile(path: string): Promise<boolean>
  open(path: string, line?: number, column?: number): void
}

export function createFileLinkProvider(terminal: FileLinkTerminal, ports: FileLinkPorts, isMac: boolean): ILinkProvider {
  // Output names files that rarely vanish mid-session; a stale hit at worst
  // opens a deleted file, which the editor reports.
  const exists = new Map<string, Promise<boolean>>()
  const isFile = (path: string): Promise<boolean> => {
    let known = exists.get(path)
    if (!known) {
      known = ports.isFile(path).catch(() => false)
      exists.set(path, known)
    }
    return known
  }

  return {
    provideLinks(y, callback) {
      const text = terminal.buffer.active.getLine(y - 1)?.translateToString(true)
      const matches = text ? parseTerminalFileMatches(text) : []
      if (!text || matches.length === 0) {
        callback(undefined)
        return
      }
      const base = ports.base()
      Promise.all(matches.map(async (match): Promise<ILink | null> => {
        const path = resolveCandidatePath(match.path, base)
        if (!(await isFile(path))) return null
        return {
          // xterm ranges are 1-based and end-inclusive.
          range: { start: { x: match.start + 1, y }, end: { x: match.end, y } },
          text: text.slice(match.start, match.end),
          activate: (event) => {
            if (isTerminalLinkModifier(event, isMac)) ports.open(path, match.line, match.column)
          },
        }
      }))
        .then((links) => callback(links.filter((link): link is ILink => link !== null)))
        .catch(() => callback(undefined))
    },
  }
}
