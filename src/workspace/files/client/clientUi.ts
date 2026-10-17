// What the file models ask of the person using this client.

declare module '@kernel/interaction/contract' {
  interface ClientUi {
    /** Asks before files dropped from outside Cate are copied into
     *  `destName`. Optional: without it dropped files are copied at once. */
    confirmImportEntries?(request: { count: number; destName: string }): Promise<'copy' | 'cancel'>
  }
}

export {}
