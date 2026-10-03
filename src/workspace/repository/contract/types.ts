// Git facts the vcs capability returns. Paths are absolute paths on the
// runtime's machine; file paths inside results are repository relative.

export type GitComparisonSpec =
  | { kind: 'uncommitted'; ignoreWhitespace?: boolean }
  | { kind: 'unstaged'; ignoreWhitespace?: boolean }
  | { kind: 'staged'; ignoreWhitespace?: boolean }
  | { kind: 'commit'; commit: string; ignoreWhitespace?: boolean }
  | { kind: 'branch'; base: string; target: string; ignoreWhitespace?: boolean }

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unmerged'

export interface GitChangedFile {
  path: string
  oldPath?: string
  status: GitChangeStatus
  additions: number | null
  deletions: number | null
  binary: boolean
  staged: boolean
  working: boolean
  untracked?: boolean
}

export interface GitComparisonResult {
  spec: GitComparisonSpec
  resolvedBase: string | null
  resolvedTarget: string | null
  currentBranch: string | null
  files: GitChangedFile[]
  additions: number
  deletions: number
}

export interface GitDiffLine {
  kind: 'context' | 'add' | 'delete' | 'meta'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface GitDiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: GitDiffLine[]
}

export interface GitFileDiff {
  path: string
  oldPath?: string
  binary: boolean
  tooLarge: boolean
  byteLength: number
  patch?: string
  hunks: GitDiffHunk[]
}

export interface GitFileContent {
  exists: boolean
  size: number
  base64?: string
}

/** One porcelain status entry (index and working tree codes). */
export interface GitStatusFile {
  path: string
  index: string
  working_dir: string
}

export interface GitStatusResult {
  files: GitStatusFile[]
  current: string | null
  tracking: string | null
  ahead: number
  behind: number
}

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface GitPullResult {
  summary: { changes: number; insertions: number; deletions: number }
}

export interface GitLogEntry {
  hash: string
  message: string
  author_name: string
  author_email: string
  date: string
}

export interface GitBranchListResult {
  current: string
  branches: Array<{
    name: string
    current: boolean
    commit: string
    label: string
    isRemote: boolean
  }>
}

/** A checkout as `git worktree list` reports it. */
export interface GitWorktree {
  path: string
  /** Branch name, the short HEAD for a detached checkout, or `(unknown)`. */
  branch: string
  isBare: boolean
  isCurrent: boolean
}

export interface WorktreeStatusResult {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
}

export interface WorktreeReviewResult {
  branch: string
  baseBranch: string
  dirty: boolean
  canApply: boolean
  commits: Array<{ hash: string; message: string }>
  files: Array<{ path: string; status: string }>
  workingFiles: string[]
  message?: string
}

export type MergeResult =
  | { ok: true; result: unknown }
  | { ok: false; conflict: boolean; message: string }

export type CreatePrResult =
  | { ok: true; created: boolean; url: string; fallback?: boolean }
  | { ok: false; message: string }

export interface PrStatusResult {
  number: number
  state: string
  url: string
  isDraft: boolean
}

export interface PrSummary {
  number: number
  title: string
  headRefName: string
  author: string
  isFork: boolean
}

/** What the `status` stream sends for one checkout: a full snapshot, sent
 *  when a subscriber joins and whenever something in it changes. */
export interface RepoStatus {
  /** `cwd` holds a `.git` entry. Everything below is empty when false. */
  isRepo: boolean
  /** Current branch, null when detached or not a repo. */
  branch: string | null
  /** Tracked files differ from HEAD (untracked files do not count). */
  dirty: boolean
  tracking: string | null
  ahead: number
  behind: number
  files: GitStatusFile[]
  /** Local branch names, sorted. */
  branches: string[]
  worktrees: GitWorktree[]
}

export const EMPTY_REPO_STATUS: RepoStatus = Object.freeze({
  isRepo: false,
  branch: null,
  dirty: false,
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  branches: [],
  worktrees: [],
}) as RepoStatus

export interface WorktreeRemoveResult {
  /** Set when the checkout went away but its branch could not be deleted. */
  branchDeleteError?: string
}

export interface WorktreePruneResult {
  output: string
  /** Metadata dropped because git no longer lists the checkout. */
  removed: string[]
}

/** A Git operation ran in a folder that is not inside a Git working tree. */
export class NotARepositoryError extends Error {
  constructor(readonly dir: string) {
    super(`${dir} is not inside a Git repository`)
    this.name = 'NotARepositoryError'
  }
}
