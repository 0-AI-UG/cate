// The wallpaper port the desktop shell installs. Picking copies the image into
// the app's `canvas-backgrounds/` folder and returns the managed path, which
// becomes the `canvasBackgroundImagePath` client setting. Reading returns a
// data URL: file:// is blocked by the renderer CSP and the file lives outside
// every workspace root.

export interface CanvasBackgroundPort {
  /** Shows a picker; resolves the managed path of the copied image, or null
   *  when cancelled. */
  pickImage(): Promise<string | null>
  /** The image at a managed path as a data URL, or null when unreadable. */
  readImage(path: string): Promise<string | null>
}

let port: CanvasBackgroundPort | null = null

export function installCanvasBackgroundPort(next: CanvasBackgroundPort | null): void {
  port = next
}

/** Null on a client without a wallpaper store: only built-in wallpapers show. */
export function canvasBackgroundPort(): CanvasBackgroundPort | null {
  return port
}
