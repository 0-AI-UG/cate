// =============================================================================
// terminalFileLinkProvider — xterm ILinkProvider for file paths.
//
// WebLinksAddon only handles URLs, so file references in terminal output
// (tsc/eslint/test lines like `src/foo.ts:12:5`) need a custom provider. This
// is the impure glue around the pure core in terminalFileLinks: it reads the
// buffer line, validates candidates against the filesystem (fsStat, cached),
// and on Cmd/Ctrl+Click opens the file in an editor at the parsed line.
// =============================================================================

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import {
  parseTerminalFileMatches,
  resolveCandidatePath,
  isTerminalLinkModifier,
} from './terminalFileLinks'
import { setPendingReveal } from './editorReveal'
import { openFileAsPanel, getDocumentType } from './fileRouting'
import { useAppStore } from '../stores/appStore'

const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)

// Existence cache so repeated provideLinks calls (hover, redraw) don't re-stat
// the same paths. Keyed by absolute path; entries are sticky for the session —
// terminal output references files that almost never disappear mid-session, and
// a stale "exists" at worst opens a now-deleted file (handled by the editor).
const existsCache = new Map<string, boolean>()

async function pathIsFile(absPath: string): Promise<boolean> {
  const cached = existsCache.get(absPath)
  if (cached !== undefined) return cached
  let ok = false
  try {
    ok = (await window.electronAPI.fsStat(absPath)).isFile
  } catch {
    ok = false
  }
  existsCache.set(absPath, ok)
  return ok
}

/** Open an existing file from a terminal link, jumping to line/col for editors. */
function openFileLink(workspaceId: string, absPath: string, line?: number, column?: number): void {
  const panelId = openFileAsPanel(workspaceId, absPath)
  // Documents (pdf/image/…) have no line concept; only editors reveal a line.
  if (line && getDocumentType(absPath) === null) {
    setPendingReveal(panelId, { line, column })
  }
}

/**
 * Build an xterm ILinkProvider that linkifies existing file paths on the given
 * terminal. Relative paths resolve against `rootPath` (the terminal's cwd, else
 * the workspace root). Cmd/Ctrl+Click opens; a plain click is ignored.
 */
export function createFileLinkProvider(opts: {
  terminal: Terminal
  workspaceId: string
  rootPath: string
}): ILinkProvider {
  const { terminal, workspaceId, rootPath } = opts
  return {
    provideLinks(y, callback) {
      const bufferLine = terminal.buffer.active.getLine(y - 1)
      if (!bufferLine) {
        callback(undefined)
        return
      }
      const text = bufferLine.translateToString(true)
      const matches = parseTerminalFileMatches(text)
      if (matches.length === 0) {
        callback(undefined)
        return
      }
      Promise.all(
        matches.map(async (m): Promise<ILink | null> => {
          const absPath = resolveCandidatePath(m.path, rootPath)
          if (!(await pathIsFile(absPath))) return null
          return {
            // xterm ranges are 1-based and end-inclusive: a match over chars
            // [start, end) maps to columns start+1 .. end.
            range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
            text: text.slice(m.start, m.end),
            activate: (event) => {
              if (!isTerminalLinkModifier(event, isMacPlatform)) return
              openFileLink(workspaceId, absPath, m.line, m.column)
            },
          }
        }),
      )
        .then((links) => callback(links.filter((l): l is ILink => l !== null)))
        .catch(() => callback(undefined))
    },
  }
}

/** Resolve the base directory for relative paths: the terminal's cwd, else the
 *  workspace root. Exported so the registry can compute it at creation time. */
export function resolveLinkRoot(workspaceId: string, cwd?: string): string {
  if (cwd) return cwd
  return useAppStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ?? ''
}
