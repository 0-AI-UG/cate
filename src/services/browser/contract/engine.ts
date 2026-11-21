// Native browser-engine surface transport. Only the desktop shell receives
// the connection secret; remote pages have no access to this bridge.
export interface BrowserSurfaceConnection {
  id: number
  url: string
  token: string
}

export interface BrowserSurfaceOptions {
  partition: string
  panelId: string
  tabId: string
  url: string
  width: number
  height: number
  scaleFactor: number
}

export interface BrowserEngineBridge {
  create(options: BrowserSurfaceOptions): Promise<BrowserSurfaceConnection>
  close(id: number): Promise<void>
  focus(id: number, focused: boolean): void
  icon(partition: string, url: string): Promise<string | null>
}

export const BROWSER_ENGINE_CHANNELS = {
  create: 'cate:browser-engine:create',
  close: 'cate:browser-engine:close',
  icon: 'cate:browser-engine:icon',
  focus: 'cate:browser-engine:focus',
} as const

export interface BrowserKeyInput {
  type: 'keyDown' | 'keyUp'
  key: string
  code: string
  keyCode: number
  alt: boolean
  control: boolean
  meta: boolean
  shift: boolean
  altGraph?: boolean
  repeat?: boolean
}

/** Native edit bindings belong to the page. CDP dispatches keydown first,
 *  so a web editor can cancel its default editing command. */
export function browserKeyEvent(input: BrowserKeyInput, platform: string) {
  const mac = platform === 'darwin'
  const primary = mac ? input.meta : input.control && !input.altGraph
  let command: string | undefined
  if (input.type === 'keyDown') {
    if (primary) {
      const edits: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: input.shift ? 'pasteAndMatchStyle' : 'paste', z: input.shift ? 'redo' : 'undo', y: 'redo' }
      command = edits[input.key.toLowerCase()]
    }
    if (mac && input.meta && !input.alt) {
      const moves: Record<string, string> = { ArrowLeft: 'moveToBeginningOfLine', ArrowRight: 'moveToEndOfLine', ArrowUp: 'moveToBeginningOfDocument', ArrowDown: 'moveToEndOfDocument', Backspace: 'deleteToBeginningOfLine', Delete: 'deleteToEndOfLine' }
      const move = moves[input.key]
      if (move) command = input.shift && move.startsWith('move') ? `${move}AndModifySelection` : move
    }
    if (mac && input.control && !input.meta && !input.alt) {
      const controls: Record<string, string> = { a: 'moveToBeginningOfLine', e: 'moveToEndOfLine', b: 'moveBackward', f: 'moveForward', h: 'deleteBackward', d: 'deleteForward', k: 'deleteToEndOfParagraph', n: 'moveDown', p: 'moveUp' }
      command = controls[input.key.toLowerCase()]
    }
  }
  const typing = input.type === 'keyDown' && (!input.meta && !input.control || input.altGraph)
  const text = typing ? input.key === 'Enter' ? '\r' : input.key.length === 1 ? input.key : undefined : undefined
  return { type: input.type, key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode,
    modifiers: Number(input.alt) | Number(input.control) << 1 | Number(input.meta) << 2 | Number(input.shift) << 3,
    autoRepeat: input.repeat ?? false, ...(text ? { text, unmodifiedText: text } : {}), ...(command ? { commands: [command] } : {}) }
}
