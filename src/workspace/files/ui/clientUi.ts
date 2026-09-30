// A dialog the file views ask of the person using this client. Optional:
// without it dropped files are copied at once.

declare module '@kernel/ui/contract' {
  interface ClientUi {
    /** Asks before files dropped from the OS are copied into `destName`. */
    confirmImportEntries?(request: { count: number; destName: string }): Promise<'copy' | 'cancel'>
  }
}

export {}
