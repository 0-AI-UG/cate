export const CATE_FILE_MIME = 'application/cate-file'
export const CATE_FILES_MIME = 'application/cate-files'
export const CATE_FILE_LINE_MIME = 'application/cate-file-line'
export const CHAT_DRAG_MIME = 'application/cate-chat'

/** A durable Cate Agent chat dragged from a chat list. */
export interface ChatDragPayload {
  chatId: string
  rootPath: string
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
    if (typeof value.chatId !== 'string' || typeof value.rootPath !== 'string') return null
    return {
      chatId: value.chatId,
      rootPath: value.rootPath,
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

/** True when the drag carries a Cate chat payload. A type-only check (getData is
 *  unavailable during dragover) for the panel drop guards that must let a chat
 *  bubble to the canvas / dock zone instead of swallowing it as a file drop. */
export function hasChatDrag(dataTransfer: Pick<DataTransfer, 'types'> | null): boolean {
  return !!dataTransfer && dataTransfer.types.includes(CHAT_DRAG_MIME)
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
