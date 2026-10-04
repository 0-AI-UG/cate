// The harness page as the chat view drives it, and the scripts it runs there.

/** The harness page's native surface (a `<webview>` on desktop). */
export interface T3Guest {
  getURL(): string
  insertCSS(css: string): Promise<string>
  executeJavaScript(code: string): Promise<unknown>
  loadURL(url: string): Promise<void>
  focus(): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

export interface GuestDropFile {
  name: string
  type: string
  dataUrl: string
}

/** Recreates dropped files in the page and drops them on its composer. */
export function t3FileDropScript(files: readonly GuestDropFile[]): string {
  return `void (async () => {
    const transfer = new DataTransfer();
    for (const source of ${JSON.stringify(files)}) {
      const blob = await (await fetch(source.dataUrl)).blob();
      transfer.items.add(new File([blob], source.name, { type: source.type || blob.type }));
    }
    const target = document.querySelector('textarea, [contenteditable="true"]') || document.body;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  })()`
}

/** Per-turn change summaries for the page's turn chips. */
export function t3ChangesScript(changes: { threadId: string; turns: Record<string, unknown> }): string {
  return `window.__cateChanges = ${JSON.stringify(changes)}; window.dispatchEvent(new Event('cate-changes'));`
}

/** Submits a prompt through the page composer (a fresh chat holds its
 *  provider and model choice only there). Evaluates to true when sent. */
export function t3SendTextScript(text: string): string {
  return `(async () => (await window.__cateChat?.sendText?.(${JSON.stringify(text)})) === true)()`
}

/** Moves the page to `url` in place through T3's router (patched to
 *  `window.__cateRouter`), so the page keeps its state and its stream; a page
 *  without the router loads `url`. */
export function t3NavigateScript(url: string): string {
  const { pathname, search } = new URL(url)
  return `(() => {
    const router = window.__cateRouter;
    if (router) void router.navigate({ href: ${JSON.stringify(pathname + search)}, replace: true });
    else location.replace(${JSON.stringify(url)});
  })()`
}
