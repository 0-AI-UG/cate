import type { Point } from '../../../shared/types'
import type { PanelPlacement } from '../../stores/appStore'
import { useAppStore } from '../../stores/appStore'

export type DocumentType = 'pdf' | 'docx' | 'image'

const DOCUMENT_EXTENSIONS: Record<string, DocumentType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.tiff': 'image',
  '.tif': 'image',
}

export function getDocumentType(filePath: string): DocumentType | null {
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex === -1) return null
  const ext = filePath.slice(dotIndex).toLowerCase()
  return DOCUMENT_EXTENSIONS[ext] ?? null
}

const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown'])

export function openFileAsPanel(
  workspaceId: string,
  filePath: string,
  position?: Point,
  placement?: PanelPlacement,
): string {
  const store = useAppStore.getState()
  const dotIndex = filePath.lastIndexOf('.')
  const ext = dotIndex !== -1 ? filePath.slice(dotIndex).toLowerCase() : ''
  const docType = getDocumentType(filePath)
  if (docType) {
    return store.createDocument(workspaceId, filePath, docType, position, placement)
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return store.createBrowser(workspaceId, `file://${filePath}`, position, placement)
  }
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return store.createEditor(workspaceId, filePath, position, placement, { markdownPreview: true })
  }
  return store.createEditor(workspaceId, filePath, position, placement)
}
