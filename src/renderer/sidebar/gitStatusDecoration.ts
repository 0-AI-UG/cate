// =============================================================================
// gitStatusDecoration — maps git porcelain status to VS Code-style file-tree
// decorations (a colored single-letter badge + name tint) for the Explorer.
//
// The M/A/D/R color palette mirrors the Source Control view
// (SourceControlView.tsx) so the Explorer and the git panel agree. One
// deliberate difference: untracked files are shown GREEN (like VS Code's "U"
// badge) instead of muted, since the Explorer surfaces brand-new files inline.
//
// All paths are compared in POSIX (forward-slash) form: git always emits
// forward slashes, while the filesystem layer hands us native separators
// (backslashes on Windows). `toPosixPath` normalizes both sides so map/set
// lookups match cross-platform.
// =============================================================================

/** One file entry from the GIT_STATUS IPC result (paths are repo-cwd-relative). */
export interface GitStatusFileEntry {
  path: string
  /** Staged (index) status char: ' ' M A D R C T U ?. */
  index: string
  /** Working-tree status char: ' ' M A D R C T U ?. */
  working_dir: string
}

export interface GitDecoration {
  /** Single-letter status badge, e.g. 'M', 'A', 'D', 'R', 'U', '!'. */
  letter: string
  /** Tailwind text-color class applied to both the name tint and the badge. */
  colorClass: string
  /** Human-readable status, used for the badge tooltip. */
  title: string
  /** Strike the name through (deleted files), VS Code style. */
  strike?: boolean
}

/** Aggregate change flavor used to tint a folder that contains changes. */
export type FolderChangeKind = 'changed' | 'untracked'

export interface GitTreeDecorations {
  /** Absolute (posix) file path -> decoration, for files with a change. */
  files: Map<string, GitDecoration>
  /** Absolute (posix) directory path -> aggregate kind, for changed ancestors. */
  dirs: Map<string, FolderChangeKind>
}

/** Everything the file tree needs to render git state, passed down per row. */
export interface GitTree {
  decorations: GitTreeDecorations
  /** Absolute (posix) paths of all git-tracked files. A file that is neither
   *  decorated nor tracked is git-ignored (rendered dimmed, like VS Code). */
  tracked: Set<string>
}

/** Normalize OS-native separators to forward slashes for cross-platform path
 *  comparison. No-op (fast path) when the string has no backslash. */
export function toPosixPath(p: string): string {
  return p.indexOf('\\') === -1 ? p : p.replace(/\\/g, '/')
}

const FOLDER_COLOR: Record<FolderChangeKind, string> = {
  // A folder containing real (tracked) changes reads as "modified"; a folder
  // that only holds brand-new files reads as "untracked".
  changed: 'text-yellow-400',
  untracked: 'text-green-400',
}

export function folderColorClass(kind: FolderChangeKind): string {
  return FOLDER_COLOR[kind]
}

/** The status char that best represents a file's state: prefer an unstaged
 *  working-tree change, otherwise fall back to the staged (index) change. The
 *  inline Explorer intentionally collapses staged+unstaged ('MM') to a single
 *  letter for brevity — the Source Control view shows the full matrix.
 *  ('?' in working_dir means untracked; the index is also '?', so it stays '?'.) */
export function effectiveStatusChar(index: string, workingDir: string): string {
  return workingDir !== ' ' && workingDir !== '?' ? workingDir : index
}

/** Decoration for a single file's status pair, or null when unmodified. */
export function gitDecorationFor(index: string, workingDir: string): GitDecoration | null {
  const c = effectiveStatusChar(index, workingDir)
  switch (c) {
    case 'M': return { letter: 'M', colorClass: 'text-yellow-400', title: 'Modified' }
    case 'A': return { letter: 'A', colorClass: 'text-green-400', title: 'Added' }
    case 'D': return { letter: 'D', colorClass: 'text-red-400', title: 'Deleted', strike: true }
    case 'R': return { letter: 'R', colorClass: 'text-blue-400', title: 'Renamed' }
    case 'C': return { letter: 'C', colorClass: 'text-green-400', title: 'Copied' }
    case 'T': return { letter: 'T', colorClass: 'text-yellow-400', title: 'Type changed' }
    case '?': return { letter: 'U', colorClass: 'text-green-400', title: 'Untracked' }
    case 'U': return { letter: '!', colorClass: 'text-orange-400', title: 'Conflict' }
    case ' ':
    case '':
      return null
    default:
      return { letter: c.trim() || 'M', colorClass: 'text-muted', title: 'Changed' }
  }
}

function parentDir(absPath: string): string {
  const slash = absPath.lastIndexOf('/')
  return slash <= 0 ? '' : absPath.slice(0, slash)
}

/** Build the decoration maps for a whole repo status response.
 *  @param files    GIT_STATUS files (paths relative to repoRoot)
 *  @param repoRoot absolute path the relative paths are joined onto */
export function buildGitTreeDecorations(
  files: GitStatusFileEntry[],
  repoRoot: string,
): GitTreeDecorations {
  const root = toPosixPath(repoRoot)
  const fileMap = new Map<string, GitDecoration>()
  const dirMap = new Map<string, FolderChangeKind>()

  for (const f of files) {
    const decoration = gitDecorationFor(f.index, f.working_dir)
    if (!decoration) continue
    // Git status run from a subdirectory can report repo-wide changes with a
    // `../` prefix; those match no tree node, so skip anything escaping the root.
    const relPath = toPosixPath(f.path)
    if (relPath.startsWith('..') || relPath.includes('/../')) continue

    const absPath = `${root}/${relPath}`
    fileMap.set(absPath, decoration)

    const kind: FolderChangeKind =
      effectiveStatusChar(f.index, f.working_dir) === '?' ? 'untracked' : 'changed'

    // Propagate the change up every ancestor directory, up to and including the
    // repo root, recording the strongest kind seen ('changed' beats 'untracked').
    let dir = parentDir(absPath)
    while (dir.length >= root.length && dir.startsWith(root)) {
      const existing = dirMap.get(dir)
      // Already 'changed' (strongest) — ancestors were set in a prior walk too.
      if (existing === 'changed') break
      // Same kind already propagated upward from here on this/earlier walks.
      if (existing === kind) break
      dirMap.set(dir, kind) // null -> kind, or upgrade 'untracked' -> 'changed'
      if (dir === root) break
      dir = parentDir(dir)
    }
  }

  return { files: fileMap, dirs: dirMap }
}

/** Resolved git decoration for one tree node, after posix-normalizing its path. */
export interface NodeGitDecoration {
  /** File decoration (badge + name tint), if the file has a change. */
  decoration?: GitDecoration
  /** Folder tint kind, if this directory contains changes. */
  folderKind?: FolderChangeKind
  /** True for a file that is git-ignored (not tracked, not changed). */
  isIgnored: boolean
}

const EMPTY_NODE_DECORATION: NodeGitDecoration = { isIgnored: false }

/** Look up the decoration for a tree node (file or directory). Returns an empty
 *  result outside a git repo. Used by both the tree and the search results so
 *  they decorate consistently. */
export function lookupNodeDecoration(
  git: GitTree | undefined,
  path: string,
  isDirectory: boolean,
): NodeGitDecoration {
  if (!git) return EMPTY_NODE_DECORATION
  const p = toPosixPath(path)
  if (isDirectory) {
    return { folderKind: git.decorations.dirs.get(p), isIgnored: false }
  }
  const decoration = git.decorations.files.get(p)
  return { decoration, isIgnored: !decoration && !git.tracked.has(p) }
}
