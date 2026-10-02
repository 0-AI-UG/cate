// Dialogs the file views ask of the person using this client.

import type { SavePathRequest } from './SavePathDialog'

declare module '@kernel/ui/contract' {
  interface ClientUi {
    /** Asks before files dropped from the OS are copied into `destName`.
     *  Optional: without it dropped files are copied at once. */
    confirmImportEntries?(request: { count: number; destName: string }): Promise<'copy' | 'cancel'>
    /** Asks where to save a file in the workspace: an absolute path on its
     *  runtime, or null when cancelled. `showSavePathDialog` is the portable
     *  implementation. */
    pickSavePath(request: SavePathRequest): Promise<string | null>
  }
}

export {}
