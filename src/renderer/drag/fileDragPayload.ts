export const CATE_FILE_MIME = 'application/cate-file'
export const CATE_FILES_MIME = 'application/cate-files'
export const CATE_FILE_LINE_MIME = 'application/cate-file-line'
export const CHAT_DRAG_MIME = 'application/cate-chat'

/** A chat dragged from the sidebar tab strip or a panel's recents. `chatId` is
 *  the durable chatsStore record; it is absent only for a coding session that has
 *  no durable record yet (dragged from the recents list) — that case carries a
 *  `sessionFile` so the drop can resume it. */
export interface ChatDragPayload {
  chatId?: string
  mode: 'coding' | 'loop'
  rootPath: string
  agentKey?: string
  sessionFile?: string
  worktreeId?: string
}

export function setChatDrag(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  payload: ChatDragPayload,
): void {
  dataTransfer.setData(CHAT_DRAG_MIME, JSON.stringify(payload))
}

export function readChatDrag(dataTransfer: Pick<DataTransfer, 'getData'>): ChatDragPayload | null {
  const encoded = dataTransfer.getData(CHAT_DRAG_MIME)
  if (!encoded) return null
  try {
    const value = JSON.parse(encoded) as Partial<ChatDragPayload>
    if ((value.mode !== 'coding' && value.mode !== 'loop') || typeof value.rootPath !== 'string') return null
    return {
      mode: value.mode,
      rootPath: value.rootPath,
      ...(typeof value.chatId === 'string' ? { chatId: value.chatId } : {}),
      ...(typeof value.agentKey === 'string' ? { agentKey: value.agentKey } : {}),
      ...(typeof value.sessionFile === 'string' ? { sessionFile: value.sessionFile } : {}),
      ...(typeof value.worktreeId === 'string' ? { worktreeId: value.worktreeId } : {}),
    }
  } catch {
    return null
  }
}

export interface FileLineLocation {
  path: string
  line: number
  column: number
}

export function hasCateFileDrag(dataTransfer: Pick<DataTransfer, 'types'> | null): boolean {
  return !!dataTransfer &&
    (dataTransfer.types.includes(CATE_FILE_MIME) || dataTransfer.types.includes(CATE_FILES_MIME))
}

export function writeCateFileDrag(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  paths: string[],
  location?: FileLineLocation,
): void {
  if (paths.length === 0) return
  dataTransfer.setData(CATE_FILE_MIME, paths[0])
  dataTransfer.setData(CATE_FILES_MIME, JSON.stringify(paths))
  if (location) dataTransfer.setData(CATE_FILE_LINE_MIME, JSON.stringify(location))
}

export function readCateFilePaths(dataTransfer: Pick<DataTransfer, 'getData'>): string[] {
  const encoded = dataTransfer.getData(CATE_FILES_MIME)
  if (encoded) {
    try {
      const values = JSON.parse(encoded)
      if (Array.isArray(values)) return values.filter((value): value is string => typeof value === 'string')
    } catch { /* malformed drag payload */ }
  }
  const single = dataTransfer.getData(CATE_FILE_MIME)
  return single ? [single] : []
}

export function readCateFileLocation(dataTransfer: Pick<DataTransfer, 'getData'>): FileLineLocation | null {
  const encoded = dataTransfer.getData(CATE_FILE_LINE_MIME)
  if (!encoded) return null
  try {
    const value = JSON.parse(encoded) as Partial<FileLineLocation>
    if (typeof value.path !== 'string' || typeof value.line !== 'number') return null
    return { path: value.path, line: value.line, column: typeof value.column === 'number' ? value.column : 1 }
  } catch {
    return null
  }
}
