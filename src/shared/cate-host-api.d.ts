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

/** Result of one agent turn (`cate.agent.send`): the flattened
 *  `text` for convenience plus the raw final assistant `message` from pi (its role
 *  and content blocks — text, tool calls, etc.), or null if the turn produced none. */
export interface AgentTurnResult {
  text: string
  message: Record<string, unknown> | null
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
  /** List this window's panels (requires the `panel` scope). Panels detached
   *  into other windows are not included. THE single enumeration surface: the
   *  focused entry answers "what is the user looking at", and browser panels
   *  carry their `url` (there is no separate browser list). */
  list(): Promise<CatePanelInfo[]>
  /** Reveal/focus a panel by id (requires the `panel` scope). */
  focus(panelId: string): Promise<unknown>
}

/** One open panel, as reported by `cate.panel.list()`. `filePath` is the bare
 *  runtime path (same form as `workspace.get().rootPath`), present for panels
 *  backed by a file (editors, documents). `url` is present for browser panels
 *  (empty while on the start page). */
export interface CatePanelInfo {
  panelId: string
  type: string
  title: string
  focused: boolean
  filePath?: string
  url?: string
}

/** A file the user dragged onto this extension's panel, delivered to
 *  `cate.files.onDrop`. The host reads the file (the user gesture authorises it),
 *  so the guest never touches the filesystem. `text` is the UTF-8 content, capped
 *  by the host; `truncated` flags when the file was larger than the cap. */
export interface CateDroppedFile {
  /** Base name, e.g. `019f0072-….jsonl`. */
  name: string
  /** Absolute path on disk, or null for an OS drop with no resolvable path. */
  path: string | null
  /** UTF-8 file content (possibly truncated). */
  text: string
  /** Byte size on disk when known. */
  size?: number
  /** True when `text` was cut to the host's size cap. */
  truncated?: boolean
}

/** One interactable element in an accessibility `snapshot()`. `ref` is an opaque
 *  handle to pass back to `click`/`type`; it is only valid for the snapshot it
 *  came from (re-snapshot after a navigation or mutation). */
export interface CateBrowserRef {
  ref: string
  role: string
  name: string
  value?: string
}

/** Accessibility snapshot of a browser panel, from `cate.browser.snapshot()`. */
export interface CateBrowserSnapshot {
  url: string
  title: string
  refs: CateBrowserRef[]
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
    /** Open a new panel. Only the fields declared here are honored by the host;
     *  `position` pins the panel to that canvas point (otherwise it follows the
     *  user's Cmd+T/Cmd+N placement setting). `filePath` is confined to the
     *  workspace root. For `type: 'extension'`, `extensionPanelId` is required and
     *  `extensionId` defaults to the calling extension. */
    createPanel(
      type: string,
      opts?: {
        position?: { x: number; y: number }
        url?: string
        filePath?: string
        extensionId?: string
        extensionPanelId?: string
      },
    ): Promise<unknown>
  }
  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<unknown>
  }
  /** Files dropped onto this panel (from the OS or Cate's file explorer). Requires
   *  the `files.drop` scope; the host reads each file and hands the guest its
   *  content, so the extension never gets raw filesystem access. */
  files: {
    /** Subscribe to drops on this panel. Returns an unsubscribe function. */
    onDrop(cb: (files: CateDroppedFile[]) => void): () => void
  }
  /** Drive Cate's bundled agent (requires the `agent` scope + first-use user
   *  consent). pi owns all conversation state on its session file; the handle
   *  returned by `open` is that file's path, so a conversation can be resumed
   *  later with nothing persisted on Cate's side. Turn-based: each `send`
   *  resolves on the agent's terminal `agent_end` (a turn can take minutes). One
   *  live session per extension; one turn in flight per session. */
  agent: {
    /** Open (or `resume` a previous) session; returns its handle. */
    open(opts?: { resume?: string }): Promise<{ sessionId: string } | { error: string }>
    /** Run one turn on an open session; returns the final assistant message. */
    send(sessionId: string, prompt: string): Promise<AgentTurnResult | { error: string }>
    /** Tear down the live session (pi's jsonl stays; reopen via `resume`). */
    dispose(sessionId: string): Promise<unknown>
    /** Abort the in-flight turn of this extension's session. */
    cancel(): Promise<unknown>
  }
  /** Drive Cate's browser panels (requires the `browser` scope). These panels
   *  hold the user's real, logged-in browser session — cookies, auth, and all —
   *  so anything the user can reach while signed in, the extension can too. Treat
   *  it accordingly. Every method targets a single panel; `panelId` picks it, and
   *  when omitted the host uses the focused (or only) browser panel. `open` can
   *  point an existing panel at a URL or spawn one. `snapshot` returns opaque
   *  element `ref`s to feed back to `click`/`type`; re-snapshot after any
   *  navigation because refs don't survive it. `screenshot` returns a host
   *  filesystem `path` (see the note in docs/extensions.md — a webview guest can't
   *  read it directly; a server-backed extension can). */
  browser: {
    /** Point a panel at `url` (or open a new one); returns the target panel + url.
     *  To enumerate open browser panels, use `cate.panel.list()`. */
    open(opts: { url: string; panelId?: string }): Promise<{ panelId: string; url: string }>
    /** Reload a panel. */
    reload(opts?: { panelId?: string }): Promise<{ ok: true }>
    /** Capture a screenshot; returns a host filesystem path. */
    screenshot(opts?: { panelId?: string }): Promise<{ path: string }>
    /** Accessibility snapshot with interactable element refs. */
    snapshot(opts?: { panelId?: string }): Promise<CateBrowserSnapshot>
    /** Click the element identified by `ref` (from a recent `snapshot`). */
    click(opts: { ref: string; panelId?: string }): Promise<{ ok: true }>
    /** Type `text` into the element identified by `ref`. */
    type(opts: { ref: string; text: string; panelId?: string }): Promise<{ ok: true }>
    /** Resolve once the panel stops loading (poll-based; `timeoutMs` defaults to
     *  5000 and is capped at 8000). Rejects in-band with `still-loading`. */
    wait(opts?: { panelId?: string; timeoutMs?: number }): Promise<{ url: string; title: string; loading: false }>
    /** Press a named key (Enter, Tab, Escape, Backspace, Delete, Space, arrows,
     *  PageUp/PageDown, Home, End) as TRUSTED input — unlike `click`/`type`,
     *  which synthesise untrusted DOM events — so Enter submits forms. With
     *  `ref` the element is focused first; without it the key goes to the
     *  guest's current focus. */
    press(opts: { key: string; ref?: string; panelId?: string }): Promise<{ ok: true }>
  }
  storage: CateHostStorage
}

declare global {
  interface Window {
    cate: CateHost
  }
}
