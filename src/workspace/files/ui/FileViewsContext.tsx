// What the file views ask of the layers above them: opening panels. The client
// provides it; views fall back to doing nothing without a provider.

import { createContext, useContext } from 'react'

export interface FileViewsHost {
  /** Opens files as panels: a dock tab by default, a canvas node for 'canvas'. */
  openFiles(workspaceId: string, paths: string[], mode?: 'dock' | 'canvas'): void
  /** Opens a file at a line and 1-based column. */
  openMatch(workspaceId: string, path: string, line: number, column: number): void
  /** Opens a terminal in `cwd`, placed next to `panelId` when given. */
  openTerminal(workspaceId: string, cwd: string, panelId?: string): void
}

const NO_HOST: FileViewsHost = {
  openFiles: () => {},
  openMatch: () => {},
  openTerminal: () => {},
}

export const FileViewsContext = createContext<FileViewsHost>(NO_HOST)

export function useFileViewsHost(): FileViewsHost {
  return useContext(FileViewsContext)
}
