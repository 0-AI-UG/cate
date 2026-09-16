import { formatLocator, parseLocator } from './runtimeLocator'

/** Reserved, persistent working files for connected untitled text editors. */
export function isEditorDraft(path: string | undefined): boolean {
  return !!path && /[/\\]\.cate[/\\]drafts[/\\][\da-f-]{36}\.md$/i.test(parseLocator(path).path)
}

export function editorDraftPath(root: string, id: string): string {
  const locator = parseLocator(root)
  return formatLocator({ ...locator, path: `${locator.path.replace(/[/\\]$/, '')}/.cate/drafts/${id}.md` })
}

export function editorDraftDirectory(path: string): string {
  const locator = parseLocator(path)
  return formatLocator({ ...locator, path: locator.path.replace(/[/\\][^/\\]+$/, '') })
}
