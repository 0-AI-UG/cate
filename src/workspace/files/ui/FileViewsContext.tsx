// What the file views ask of the layers above them: opening panels and what
// the client can do. The client provides it; without a provider views do
// nothing and take no OS files.

import { createContext, useContext } from 'react'

export interface FileViewsHost {
  /** Opens files as panels: a dock tab by default, a canvas node for 'canvas'. */
  openFiles(workspaceId: string, paths: string[], mode?: 'dock' | 'canvas'): void
  /** Opens a file at a line and 1-based column. */
  openMatch(workspaceId: string, path: string, line: number, column: number): void
  /** Opens a terminal in `cwd`, placed next to `panelId` when given. */
  openTerminal(workspaceId: string, cwd: string, panelId?: string): void
  /** True when this client can take files dropped from the OS (the
   *  `fileDrop` feature). */
  takesOsFiles(): boolean
}

const NO_HOST: FileViewsHost = {
  openFiles: () => {},
  openMatch: () => {},
  openTerminal: () => {},
  takesOsFiles: () => false,
}

export const FileViewsContext = createContext<FileViewsHost>(NO_HOST)

export function useFileViewsHost(): FileViewsHost {
  return useContext(FileViewsContext)
}
