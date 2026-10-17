// The in-app "Save As" dialog: browses the workspace's files through its
// runtime (whichever machine that is), never above `rootPath`, and resolves
// the chosen absolute path,
// or null when cancelled. Mounted on demand by `showSavePathDialog`, which a
// shell installs as `ClientUi.pickSavePath`.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUp, File as FileIcon, Folder, FolderPlus } from 'lucide-react'
import { LoadingState, Modal, btn, inputCls } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { pathDisplayName, pathHasPrefix, pathKey, toAbsolutePath, type FileEntry } from '@workspace/files/contract'
import { fsClient } from '@workspace/files/client'

export interface SavePathRequest {
  workspaceId: string
  /** Absolute path suggested: the dialog opens in its folder with its name. */
  defaultPath: string
  /** The folder the dialog cannot leave: the breadcrumb starts here. */
  rootPath: string
  title?: string
}

/** The folder above `dir`; `dir` itself at a filesystem root. */
export function parentDir(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return dir
  if (cut === 0) return trimmed[0]
  const up = trimmed.slice(0, cut)
  return /^[A-Za-z]:$/.test(up) ? `${up}${trimmed[cut]}` : up
}

const isRoot = (dir: string, root: string) => pathKey(dir) === pathKey(root)

function crumbsOf(dir: string, root: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = []
  for (let current = dir; ; current = parentDir(current)) {
    out.unshift({ name: pathDisplayName(current) || current, path: current })
    if (isRoot(current, root) || parentDir(current) === current) return out
  }
}

const byKindThenName = (a: FileEntry, b: FileEntry) =>
  a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1

const badName = (name: string) => /[\\/]/.test(name) || name === '.' || name === '..'

export function SavePathDialog({ workspaceId, defaultPath, rootPath, title = 'Save As', onDone }: SavePathRequest & { onDone: (path: string | null) => void }) {
  const fs = useMemo(() => fsClient(workspaceId), [workspaceId])
  const [dir, setDir] = useState(() => {
    const start = parentDir(defaultPath)
    return pathHasPrefix(pathKey(start), pathKey(rootPath)) ? start : rootPath
  })
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState(() => pathDisplayName(defaultPath))
  const [folderName, setFolderName] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const open = useCallback((next: string) => {
    setDir(next)
    setSelected(null)
    setReplacing(null)
    setError(null)
  }, [])

  useEffect(() => {
    let live = true
    setEntries(null)
    fs.readDir(dir).then(
      (list) => { if (live) setEntries([...list].sort(byKindThenName)) },
      (err: unknown) => { if (live) { setEntries([]); setError(errorMessage(err, 'Could not read this folder.')) } },
    )
    return () => { live = false }
  }, [fs, dir])

  // Select the name without its extension, as native dialogs do.
  useEffect(() => {
    const input = nameRef.current
    if (!input) return
    const dot = input.value.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
  }, [])

  const save = async (fileName = name) => {
    const trimmed = fileName.trim()
    if (!trimmed) return
    if (badName(trimmed)) { setError('A file name can’t contain / or \\.'); return }
    const target = toAbsolutePath(trimmed, dir)
    const existing = await fs.stat(target).catch(() => null)
    if (existing?.isDirectory) { setError(`“${trimmed}” is a folder.`); return }
    if (existing) { setReplacing(target); return }
    onDone(target)
  }

  const createFolder = async () => {
    const trimmed = folderName?.trim()
    if (!trimmed) { setFolderName(null); return }
    if (badName(trimmed)) { setError('A folder name can’t contain / or \\.'); return }
    const target = toAbsolutePath(trimmed, dir)
    try {
      await fs.mkdir(target)
      setFolderName(null)
      open(target)
    } catch (err) {
      setError(errorMessage(err, 'Could not create the folder.'))
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || (folderName === null && !replacing)) return
    event.preventDefault()
    event.stopPropagation()
    setFolderName(null)
    setReplacing(null)
  }

  const up = isRoot(dir, rootPath) ? dir : parentDir(dir)
  return (
    <Modal title={title} onClose={() => onDone(null)} width={520} closeOnEscape={folderName === null && !replacing} bodyClassName="min-h-0 flex-1 flex flex-col">
      <div className="flex flex-col gap-3 p-4 min-h-0" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-1">
          <button type="button" className={btn.ghost} onClick={() => open(up)} disabled={up === dir} aria-label="Up one folder"><ArrowUp size={14} /></button>
          <nav aria-label="Folder" className="no-scrollbar min-w-0 flex-1 flex items-center gap-0.5 overflow-x-auto text-[12px]">
            {crumbsOf(dir, rootPath).map((crumb, index, all) => (
              <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                {index > 0 && <span className="text-muted">/</span>}
                <button
                  type="button"
                  onClick={() => open(crumb.path)}
                  className={`rounded px-1.5 py-0.5 hover:bg-hover ${index === all.length - 1 ? 'text-primary font-medium' : 'text-secondary'}`}
                >{crumb.name}</button>
              </span>
            ))}
          </nav>
          <button type="button" className={btn.ghost} onClick={() => { setError(null); setFolderName('') }}><FolderPlus size={14} />New Folder</button>
        </div>
        <div role="listbox" aria-label="Files" className="h-64 overflow-auto rounded-md border border-subtle bg-surface-0 p-1">
          {folderName !== null && (
            <form className="flex items-center gap-2 px-2 py-1" onSubmit={(event) => { event.preventDefault(); void createFolder() }}>
              <Folder size={14} className="shrink-0 text-muted" />
              <input
                autoFocus
                aria-label="New folder name"
                className={inputCls}
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
              />
            </form>
          )}
          {entries === null && <LoadingState size={12} className="justify-start px-2 py-1 text-[12px]" />}
          {entries?.length === 0 && !error && <div className="px-2 py-1 text-[12px] text-muted">This folder is empty.</div>}
          {entries?.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={selected === entry.path}
              onClick={() => {
                setSelected(entry.path)
                if (!entry.isDirectory) setName(entry.name)
              }}
              onDoubleClick={() => {
                if (entry.isDirectory) open(entry.path)
                else { setName(entry.name); void save(entry.name) }
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] ${selected === entry.path ? 'bg-surface-4 text-primary' : 'hover:bg-hover'} ${entry.isDirectory ? 'text-primary' : 'text-muted'}`}
            >
              {entry.isDirectory ? <Folder size={14} className="shrink-0 text-secondary" /> : <FileIcon size={14} className="shrink-0" />}
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
        </div>
        {error && <div role="alert" className="text-[12px] text-error">{error}</div>}
        {replacing ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[13px] text-primary">“{pathDisplayName(replacing)}” already exists. Replace it?</span>
            <button type="button" className={btn.secondary} onClick={() => setReplacing(null)}>Cancel</button>
            <button type="button" autoFocus className={btn.primary} onClick={() => onDone(replacing)}>Replace</button>
          </div>
        ) : (
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <input
              ref={nameRef}
              autoFocus={folderName === null}
              aria-label="File name"
              className={inputCls}
              value={name}
              onChange={(event) => { setName(event.target.value); setError(null) }}
            />
            <button type="button" className={btn.secondary} onClick={() => onDone(null)}>Cancel</button>
            <button type="submit" className={btn.primary} disabled={!name.trim()}>Save</button>
          </form>
        )}
      </div>
    </Modal>
  )
}

/** Shows the dialog in this document until the person picks a path or
 *  cancels. Portable: needs only the DOM and the workspace's runtime. */
export function showSavePathDialog(request: SavePathRequest): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let settled = false
    const done = (path: string | null) => {
      if (settled) return
      settled = true
      resolve(path)
      queueMicrotask(() => { root.unmount(); host.remove() })
    }
    root.render(<SavePathDialog {...request} onDone={done} />)
  })
}
