// A file of a workspace, wherever its runtime runs. Every handoff of a file
// between views (drags, the file clipboard) carries refs, never bare paths;
// the client's file-ref resolver (`workspace/files/client`) makes a ref
// usable in any workspace, the same way for every runtime. Pure.

/** Where temporary files of a checkout live: connected-editor drafts and
 *  files copied in from another workspace or the OS. */
export const CATE_TEMP_DIR = '.cate/tmp'

/** `.cate/.gitignore`: only skills.json is meant to be committed. */
export const CATE_GITIGNORE = `# Cate project-local state. Only skills.json is shared; everything else
# (drafts, worktrees and scratch files) stays local.
*
!.gitignore
!skills.json
`

export function cateTempDir(checkout: string): string {
  return `${checkout.replace(/[/\\]+$/, '')}/${CATE_TEMP_DIR}`
}

export interface FileRef {
  workspaceId: string
  path: string
}

/** A line inside a dragged file (search results). */
export interface FileLineLocation {
  path: string
  line: number
  column: number
}

export const FILE_REF_SCHEME = 'cate-file'

/** `cate-file://<workspace id>/<path>`: the text form, for the clipboard. */
export function formatFileRef(ref: FileRef): string {
  const path = ref.path.replace(/\\/g, '/')
  const segments = (path.startsWith('/') ? path.slice(1) : path).split('/').map(encodeURIComponent)
  return `${FILE_REF_SCHEME}://${encodeURIComponent(ref.workspaceId)}/${segments.join('/')}`
}

export function parseFileRef(text: string): FileRef | null {
  const match = /^cate-file:\/\/([^/]+)\/(.*)$/.exec(text.trim())
  if (!match) return null
  try {
    const workspaceId = decodeURIComponent(match[1])
    const rest = match[2].split('/').map(decodeURIComponent).join('/')
    // A drive-letter path keeps its drive; anything else is absolute POSIX.
    const path = /^[A-Za-z]:\//.test(rest) ? rest : `/${rest}`
    return workspaceId ? { workspaceId, path } : null
  } catch {
    return null
  }
}

/** Refs as clipboard text, one per line. */
export function fileRefsToText(refs: readonly FileRef[]): string {
  return refs.map(formatFileRef).join('\n')
}

/** The refs of clipboard text; empty unless every line is a ref. */
export function fileRefsFromText(text: string): FileRef[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const refs = lines.map(parseFileRef)
  return refs.length > 0 && refs.every((ref) => ref !== null) ? (refs as FileRef[]) : []
}

// ---- the drag payload -----------------------------------------------------

export const FILE_REFS_MIME = 'application/cate-file-refs'

export interface FileRefDrag {
  refs: FileRef[]
  location?: FileLineLocation
}

export function hasFileRefDrag(dataTransfer: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(FILE_REFS_MIME)
}

export function writeFileRefDrag(dataTransfer: Pick<DataTransfer, 'setData'>, drag: FileRefDrag): void {
  if (drag.refs.length === 0) return
  dataTransfer.setData(FILE_REFS_MIME, JSON.stringify(drag))
  dataTransfer.setData('text/uri-list', fileRefsToText(drag.refs))
}

export function readFileRefDrag(dataTransfer: Pick<DataTransfer, 'getData'>): FileRefDrag | null {
  try {
    const value = JSON.parse(dataTransfer.getData(FILE_REFS_MIME) || 'null') as Partial<FileRefDrag> | null
    const refs = Array.isArray(value?.refs)
      ? value.refs.filter((ref): ref is FileRef => typeof ref?.workspaceId === 'string' && typeof ref?.path === 'string')
      : []
    if (refs.length === 0) return null
    const location = value?.location
    return location && typeof location.path === 'string' && typeof location.line === 'number'
      ? { refs, location: { path: location.path, line: location.line, column: typeof location.column === 'number' ? location.column : 1 } }
      : { refs }
  } catch {
    return null
  }
}
