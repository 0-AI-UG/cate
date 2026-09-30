// Connected editors (docs/connected-editors.md): an untitled editor connected
// to an agent gets a persistent working file `.cate/drafts/<id>.md` in its
// checkout. Pure path strings; `/` and `\` separators both work.

export const DRAFTS_DIR = '.cate/drafts'

/** Previews (images, PDF, DOCX) are never shared or autosaved. */
const PREVIEW_EXTENSIONS = /\.(pdf|docx|jpe?g|png|gif|svg|webp|bmp|ico|tiff?)$/i

export function isPreviewPath(path: string): boolean {
  return PREVIEW_EXTENSIONS.test(path)
}

export function isEditorDraft(path: string | undefined): boolean {
  return !!path && /[/\\]\.cate[/\\]drafts[/\\][\da-f-]{36}\.md$/i.test(path)
}

export function editorDraftPath(root: string, id: string): string {
  return `${root.replace(/[/\\]$/, '')}/${DRAFTS_DIR}/${id}.md`
}

export function editorDraftDirectory(path: string): string {
  return path.replace(/[/\\][^/\\]+$/, '')
}
