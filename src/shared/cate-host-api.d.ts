// =============================================================================
// Ambient typings for the `cate` global injected into extension webview guests
// by src/preload/cateHost.ts. Mirrors the reverse-API surface in
// docs/extensions.md. Methods not yet supported in Phase 1 still exist and
// resolve/reject with a clear "unsupported" result so feature detection via
// `cate.version` works.
// =============================================================================

/** Theme tokens handed to a guest by `cate.theme.get()`. */
export interface CateHostTheme {
  id: string
  type: 'dark' | 'light'
  /** Merged app CSS-var palette (key without leading `--`). */
  app: Record<string, string>
  /** Terminal ANSI palette. */
  terminal: Record<string, string>
}

/** Workspace context handed to a guest by `cate.workspace.get()`. */
export interface CateHostWorkspace {
  rootPath: string | null
  branch: string | null
  worktree: string | null
}

export interface CateHostStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  panel: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  /** Subscribe to storage changes (external edits or writes from other panels).
   *  Returns an unsubscribe function. */
  onChange(cb: (key?: string) => void): () => void
}

export interface CatePanel {
  /** This panel instance's id. */
  readonly id: string
  setTitle(title: string): Promise<void>
}

export interface CateHost {
  /** API version int, for feature detection. */
  version(): Promise<number>
  panel: CatePanel
  workspace: {
    get(): Promise<CateHostWorkspace>
  }
  theme: {
    get(): Promise<CateHostTheme>
  }
  editor: {
    openFile(path: string, opts?: { line?: number; column?: number }): Promise<unknown>
  }
  canvas: {
    createPanel(
      type: string,
      opts?: { position?: unknown; size?: unknown; props?: unknown },
    ): Promise<unknown>
  }
  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<unknown>
  }
  storage: CateHostStorage
}

declare global {
  interface Window {
    cate: CateHost
  }
}
