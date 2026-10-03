// "Open in browser" for an HTML file: the user picks a new panel of the type
// that opens URLs or an existing one, which loads the file as a new tab. The
// opening session serves a `file://` URL from the workspace's runtime.

import { acquireSession, createPanel, panelTypeOpening, requestPanelTarget } from '@client/host'

/** True for files a browser renders as a page. */
export const isHtmlFile = (filePath: string): boolean => /\.html?$/i.test(filePath)

/** The `file://` URL naming an absolute path. */
export function fileUrlOf(filePath: string): string {
  const path = filePath.replace(/\\/g, '/')
  return `file://${path.startsWith('/') ? '' : '/'}${path.split('/').map(encodeURIComponent).join('/')}`
}

/** False when no panel type opens URLs or the user cancelled. */
export async function openFileInBrowser(workspaceId: string, filePath: string, sourcePanelId: string): Promise<boolean> {
  const type = panelTypeOpening('url')
  if (!type) return false
  const url = fileUrlOf(filePath)
  const target = await requestPanelTarget({ workspaceId, panelType: type, availability: 'both', sourcePanelId })
  if (!target) return false
  if (target.kind === 'new') return createPanel(workspaceId, type, { url, ...target.placement }) !== null
  const session = acquireSession(workspaceId, target.panelId)
  if (!session) return false
  try {
    await session.send({ kind: 'newTab', url })
  } finally {
    session.release()
  }
  return true
}
