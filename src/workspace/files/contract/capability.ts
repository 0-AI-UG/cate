import { defineCapability, method, stream } from '@kernel/rpc/contract'
import type { BufferResolution, BufferState, BufferStreamEvent } from './buffer'
import type {
  FileEntry,
  FileSearchResult,
  FileStat,
  FileText,
  FsChange,
  ImportEntry,
  ImportResult,
  SearchDone,
  SearchFileResult,
  SearchOptions,
} from './types'

/** Files of the workspace: the root, its worktree checkouts, the workspace
 *  data directory and granted paths. Anything else fails with `rejected`.
 *  Served while the workspace is untrusted (9.2). */
export const fileCapability = defineCapability('file', {
  methods: {
    read: method<{ path: string }, FileText>(),
    /** `baseHash`: the hash the content is based on; null means the file must
     *  not exist yet; omitted writes unconditionally. Stale fails with
     *  `conflict` and `data: { hash }` (the disk hash, null when absent). */
    write: method<{ path: string; content: string; baseHash?: string | null }, { path: string; hash: string }>({ mutates: true }),
    readDir: method<{ path: string }, FileEntry[]>(),
    stat: method<{ path: string }, FileStat>(),
    remove: method<{ path: string }, void>({ mutates: true }),
    /** Moves to the OS trash where the runtime's machine has one. */
    trash: method<{ path: string }, { permanent: boolean }>({ mutates: true }),
    rename: method<{ from: string; to: string }, { path: string }>({ mutates: true }),
    mkdir: method<{ path: string }, void>({ mutates: true }),
    /** Copies into `destDir`, picking a free name ("a copy.txt", "a (2).txt"). */
    copy: method<{ path: string; destDir: string }, { path: string }>({ mutates: true }),
    /** Grants access to a path outside the workspace the user picked in a
     *  dialog. Persisted in the workspace data. */
    grant: method<{ path: string }, { path: string }>({ mutates: true }),
    saveBuffer: method<{ path: string }, BufferState>({ mutates: true }),
    resolveBuffer: method<{ path: string; resolution: BufferResolution }, BufferState>({ mutates: true }),
  },
  streams: {
    readBinary: stream<{ path: string }, never, { size: number; hash: string }>({ bytes: true }),
    /** The client writes exactly `size` bytes; the stream ends once written. */
    writeBinary: stream<{ path: string; size: number; baseHash?: string | null }, never, { path: string; hash: string }>(),
    /** Dropped files uploaded by a client: the manifest, then each file's bytes
     *  in order. */
    importEntries: stream<{ destDir: string; entries: ImportEntry[] }, never, ImportResult>(),
    /** Stores a finished browser download in the workspace data. */
    storeDownload: stream<{ filename: string; size: number }, never, { path: string }>(),
    /** Stores a screenshot (an annotated capture) in the workspace data's
     *  `screenshots/`, where agents read it back through `readBinary`. */
    storeScreenshot: stream<{ name: string; size: number }, never, { path: string }>(),
    /** Batched changes under `path`. Hidden directories and exclusions are not
     *  watched below the watched path. */
    watch: stream<{ path: string }, FsChange[]>(),
    /** Attach to the open buffer of a file (see BufferStreamEvent). */
    buffer: stream<{ path: string; stateVector?: string }, BufferStreamEvent>({ bytes: true }),
  },
})

export const searchCapability = defineCapability('search', {
  methods: {
    /** File name search (the quick finder). `root` defaults to the workspace root. */
    files: method<{ root?: string; query: string; maxResults?: number }, FileSearchResult[]>(),
  },
  streams: {
    /** ripgrep content search: batches of completed files, then the stats. */
    content: stream<{ root?: string; options: SearchOptions }, SearchFileResult[], SearchDone>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    file: typeof fileCapability
    search: typeof searchCapability
  }
}
