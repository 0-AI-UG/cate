// Types shared by the file and search capabilities. Paths are plain absolute
// paths on the runtime's machine; the connection says which runtime.

export type FsChangeType = 'create' | 'update' | 'delete'

export interface FsChange {
  path: string
  type: FsChangeType
}

/** One directory entry, as `file.readDir` lists it (one level, no symlinks). */
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  /** Extension without the dot; empty for directories. */
  extension: string
}

export interface FileStat {
  isDirectory: boolean
  isFile: boolean
  size: number
  mtimeMs: number
}

/** A text file read with the hash of its bytes, which a later write names as
 *  its base. */
export interface FileText {
  content: string
  hash: string
}

/** One entry of a dropped-files upload. `path` is relative to the drop and uses
 *  `/`; its first segment is the dropped item and may be renamed on collision.
 *  Files are followed by their bytes on the stream, in manifest order. */
export type ImportEntry =
  | { path: string; kind: 'dir' }
  | { path: string; kind: 'file'; size: number }

export interface ImportResult {
  /** Absolute paths of the created top-level entries. */
  created: string[]
  failed: number
}

// ---- search ---------------------------------------------------------------

export interface FileSearchResult {
  name: string
  path: string
  /** Relative to the search root, with forward slashes. */
  relativePath: string
  isDirectory: boolean
}

export interface SearchOptions {
  /** Literal text, or a regex when `isRegex` is set. */
  query: string
  isRegex?: boolean
  /** Case-sensitive; otherwise case-insensitive. */
  matchCase?: boolean
  wholeWord?: boolean
  /** Globs to include ("src/**", "*.ts"). Empty means all files. */
  includes?: string[]
  excludes?: string[]
  /** Default true: honour .gitignore/.ignore and the exclusion set. False also
   *  searches ignored and hidden files. */
  respectIgnore?: boolean
  /** Cap on total matches before the search is truncated. */
  maxResults?: number
}

export interface SearchMatchRange {
  /** 0-based character index where the match starts. */
  start: number
  /** Exclusive end. */
  end: number
}

export interface SearchResultLine {
  /** 1-based. */
  line: number
  /** Trailing newline stripped, long lines truncated. */
  text: string
  /** Empty for a context line. */
  ranges: SearchMatchRange[]
}

export interface SearchFileResult {
  path: string
  relativePath: string
  lines: SearchResultLine[]
  /** Individual submatches in this file. */
  matchCount: number
}

export interface SearchStats {
  matches: number
  files: number
  /** Stopped early at the cap or the time limit. */
  truncated: boolean
}

/** Result of a content search stream. `error` is set when ripgrep failed. */
export interface SearchDone {
  stats: SearchStats
  error?: string
}

/** Names hidden from listings, name search, content search and the watcher.
 *  Not user-configurable: exposing .git or node_modules makes ordinary
 *  workspace operations too noisy. */
export const FILE_EXCLUSIONS: readonly string[] = [
  '.git',
  '.DS_Store',
  '.Trash',
  'node_modules',
  '__pycache__',
  '.npm',
  '.cache',
  '.build',
  '.swiftpm',
  'DerivedData',
  'Pods',
]
