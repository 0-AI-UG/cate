// The file-ref resolver: the one place that turns a FileRef into a file a
// workspace can use. A ref of the workspace itself is its path; a ref of any
// other workspace is copied in, byte for byte through the two runtimes, into
// the target checkout's temporary folder (`.cate/tmp`). Files dropped from
// the OS are uploaded the same way. There is one path for every runtime,
// wherever it runs. Portable: no Node, no Electron.

import { joinPath, pathDisplayName, pathHasPrefix, pathKey, type FileRef } from '../contract'
import { fsClient, type FsClient, type ImportSource } from './fsClient'

export type RefFs = Pick<FsClient, 'readDir' | 'stat' | 'readBinary' | 'rename' | 'copy' | 'importEntries' | 'tempDir'>

/** Where files land in a workspace: a folder, or else the temporary folder
 *  of the checkout holding `near` (the workspace root's when omitted). */
export interface RefTarget {
  workspaceId: string
  destDir?: string
  near?: string
}

export interface FileRefs {
  /** Paths `target.workspaceId` can use for `refs`, in order: its own files
   *  as they are, other workspaces' files copied into the target (by default
   *  its temporary folder). Rejects when a copy fails. */
  localize(refs: readonly FileRef[], target: RefTarget): Promise<string[]>
  /** Moves or copies refs into `destDir` (the explorer). Moving only happens
   *  within one workspace; files of another workspace are always copied.
   *  Resolves with the paths it created or moved to. */
  transfer(refs: readonly FileRef[], target: { workspaceId: string; destDir: string }, mode: 'move' | 'copy'): Promise<string[]>
  /** Uploads files from outside any workspace (the OS) into the target. */
  upload(sources: ImportSource[], target: RefTarget): Promise<string[]>
  readBytes(ref: FileRef): Promise<Uint8Array>
}

export function createFileRefs(fsOf: (workspaceId: string) => RefFs): FileRefs {
  const destination = async (target: RefTarget): Promise<string> =>
    target.destDir ?? fsOf(target.workspaceId).tempDir(target.near)

  const upload = async (sources: ImportSource[], target: RefTarget): Promise<string[]> => {
    if (sources.length === 0) return []
    const result = await fsOf(target.workspaceId).importEntries(await destination(target), sources)
    if (result.failed > 0) throw new Error(`${result.failed} item(s) could not be copied`)
    return result.created
  }

  /** The upload manifest of refs of one workspace: folders walked, file
   *  bytes read from that workspace's runtime when sent. */
  const sourcesOf = async (workspaceId: string, paths: readonly string[]): Promise<ImportSource[]> => {
    const fs = fsOf(workspaceId)
    const out: ImportSource[] = []
    const walk = async (path: string, rel: string): Promise<void> => {
      const stat = await fs.stat(path)
      if (stat.isDirectory) {
        out.push({ path: rel, kind: 'dir' })
        for (const child of await fs.readDir(path)) await walk(child.path, `${rel}/${child.name}`)
      } else if (stat.isFile) {
        out.push({ path: rel, kind: 'file', size: stat.size, bytes: () => fs.readBinary(path) })
      }
    }
    for (const path of paths) await walk(path, pathDisplayName(path))
    return out
  }

  /** Copies foreign refs into the target, one upload each (two refs may
   *  share a name; each still gets its own free name). */
  const copyIn = async (refs: readonly FileRef[], target: RefTarget): Promise<Map<FileRef, string>> => {
    const out = new Map<FileRef, string>()
    for (const ref of refs) {
      const [created] = await upload(await sourcesOf(ref.workspaceId, [ref.path]), target)
      if (created) out.set(ref, created)
    }
    return out
  }

  return {
    async localize(refs, target) {
      const foreign = refs.filter((ref) => ref.workspaceId !== target.workspaceId)
      const copies = foreign.length > 0 ? await copyIn(foreign, target) : new Map<FileRef, string>()
      return refs.flatMap((ref) => (ref.workspaceId === target.workspaceId ? [ref.path] : copies.has(ref) ? [copies.get(ref)!] : []))
    },

    async transfer(refs, target, mode) {
      const own = refs.filter((ref) => ref.workspaceId === target.workspaceId)
      const foreign = refs.filter((ref) => ref.workspaceId !== target.workspaceId)
      const fs = fsOf(target.workspaceId)
      const out: string[] = []
      for (const { path } of own) {
        if (mode === 'copy') {
          out.push((await fs.copy(path, target.destDir)).path)
          continue
        }
        const dest = joinPath(target.destDir, pathDisplayName(path))
        // Onto itself, or a folder into itself or its own subtree.
        if (pathKey(dest) === pathKey(path) || pathHasPrefix(pathKey(target.destDir), pathKey(path))) continue
        out.push((await fs.rename(path, dest)).path)
      }
      if (foreign.length > 0) out.push(...(await copyIn(foreign, target)).values())
      return out
    },

    upload,

    readBytes: (ref) => fsOf(ref.workspaceId).readBinary(ref.path),
  }
}

/** The resolver over the open workspaces' runtimes. */
export const fileRefs: FileRefs = createFileRefs(fsClient)
