import type { CodingImageAttachment } from '../../shared/types'

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return typeof btoa === 'function' ? btoa(binary) : ''
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
}

function baseName(path: string): string {
  const match = /[^/\\]+$/.exec(path)
  return match ? match[0] : path
}

export function imageMimeForPath(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? IMAGE_MIME_BY_EXT[ext] ?? null : null
}

export async function readFileAsImage(file: File): Promise<CodingImageAttachment | null> {
  if (!file.type.startsWith('image/')) return null
  const data = bytesToBase64(await file.arrayBuffer())
  return data ? { data, mimeType: file.type, fileName: file.name } : null
}

export async function readPathAsImage(
  path: string,
  workspaceId?: string,
): Promise<CodingImageAttachment | null> {
  const mimeType = imageMimeForPath(path)
  if (!mimeType) return null
  try {
    const buffer = await window.electronAPI.fsReadBinary(path, workspaceId)
    const data = bytesToBase64(buffer)
    return data ? { data, mimeType, fileName: baseName(path) } : null
  } catch {
    return null
  }
}
