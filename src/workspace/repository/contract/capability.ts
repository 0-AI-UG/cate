// The `vcs` capability: git, `gh` and the worktree lifecycle on the runtime.
// `cwd` is an absolute path on the runtime's machine inside the workspace's
// path scope (root, worktree checkouts, grants); it defaults to the root.
// Every call fails with `untrusted` until the workspace is trusted: git runs
// hooks and config the repository controls.

import { channelStream, defineCapability, method } from '@kernel/rpc/contract'
import type { WorktreeId, WorktreeMeta } from '@workspace/document/contract'
import type {
  CreatePrResult,
  GitBranchListResult,
  GitComparisonResult,
  GitComparisonSpec,
  GitFileContent,
  GitFileDiff,
  GitLogEntry,
  GitPullResult,
  GitRemote,
  GitStatusResult,
  GitWorktree,
  MergeResult,
  PrStatusResult,
  PrSummary,
  RepoStatus,
  WorktreePruneResult,
  WorktreeRemoveResult,
  WorktreeReviewResult,
  WorktreeStatusResult,
} from './types'
import type { GitHubConnection, GitHubLoginState, PullRequestContext, PullRequestsResult } from './github'

export interface AtCwd {
  cwd?: string
}

/** Network and hook-running git work gets longer than the 30 s default. */
const NETWORK_MS = 120_000

export const vcsCapability = defineCapability('vcs', {
  methods: {
    // Repository and status
    isRepo: method<AtCwd, boolean>(),
    /** Repos at or below `dir`, at most `maxDepth` levels down (default 1),
     *  never descending into a repo it found. */
    findRepos: method<{ dir?: string; maxDepth?: number }, string[]>(),
    init: method<AtCwd, void>({ mutates: true }),
    /** Tracked and untracked-not-ignored files, relative to `cwd`. */
    lsFiles: method<AtCwd, string[]>(),
    readStatus: method<AtCwd, GitStatusResult>(),
    remotes: method<AtCwd, GitRemote[]>(),
    /** The file's page on GitHub at the current branch, from its checkout's
     *  `origin`; null when the file is not in a git repository whose origin
     *  is on github.com. `path` is absolute. */
    fileWebUrl: method<{ path: string }, { url: string } | null>(),

    // Diffs
    compare: method<AtCwd & { spec: GitComparisonSpec }, GitComparisonResult>(),
    fileDiff: method<AtCwd & { spec: GitComparisonSpec; path: string; contextLines?: number; allowLarge?: boolean }, GitFileDiff>(),
    fileContent: method<AtCwd & { spec: GitComparisonSpec; path: string; side: 'old' | 'new' }, GitFileContent>(),

    // Index and commits
    stage: method<AtCwd & { path: string }, void>({ mutates: true }),
    stageAll: method<AtCwd, void>({ mutates: true }),
    unstage: method<AtCwd & { path: string }, void>({ mutates: true }),
    discardFile: method<AtCwd & { path: string }, void>({ mutates: true }),
    commit: method<AtCwd & { message: string }, void>({ mutates: true, timeoutMs: NETWORK_MS }),
    log: method<AtCwd & { maxCount?: number }, GitLogEntry[]>(),

    // Remotes
    push: method<AtCwd & { remote?: string; branch?: string }, void>({ mutates: true, timeoutMs: NETWORK_MS }),
    pull: method<AtCwd & { remote?: string; branch?: string }, GitPullResult>({ mutates: true, timeoutMs: NETWORK_MS }),
    fetch: method<AtCwd & { remote?: string }, void>({ mutates: true, timeoutMs: NETWORK_MS }),

    // Branches and stash
    branchList: method<AtCwd, GitBranchListResult>(),
    branchCreate: method<AtCwd & { name: string; startPoint?: string }, void>({ mutates: true }),
    branchDelete: method<AtCwd & { name: string; force?: boolean }, void>({ mutates: true }),
    checkout: method<AtCwd & { branch: string }, void>({ mutates: true }),
    stash: method<AtCwd & { message?: string }, void>({ mutates: true }),
    stashPop: method<AtCwd, void>({ mutates: true }),

    // Worktrees
    worktreeList: method<AtCwd, GitWorktree[]>(),
    /** Creates a checkout at `<root>/.cate/worktrees/<slug>` and its metadata
     *  (`creating`, then `ready`). With `fromPr`, checks out that pull request
     *  (`branch` is its head ref, used for the name) on a fresh local branch.
     *  A second identical create joins the running one. */
    worktreeCreate: method<{ branch: string; base?: string; fromPr?: number; label?: string }, WorktreeMeta>({
      mutates: true,
      timeoutMs: 180_000,
    }),
    /** Removes the checkout (and its branch unless `deleteBranch: false`),
     *  then closes or moves its bound panels (`closeWorktreePanelsOnDelete`)
     *  and drops the metadata. The view asks about dirty panels first. */
    worktreeRemove: method<{ worktreeId: WorktreeId; force?: boolean; deleteBranch?: boolean }, WorktreeRemoveResult>({
      mutates: true,
      timeoutMs: NETWORK_MS,
    }),
    /** `git worktree prune`, then drops metadata whose checkout git no longer
     *  lists (with its bound panels, as for remove). */
    worktreePrune: method<void, WorktreePruneResult>({ mutates: true }),
    worktreeStatus: method<{ path: string }, WorktreeStatusResult | null>(),
    worktreeReview: method<{ path: string; baseBranch: string }, WorktreeReviewResult>(),
    worktreeMergeTo: method<AtCwd & { from: string; to: string }, MergeResult>({ mutates: true, timeoutMs: NETWORK_MS }),
    worktreeUpdateFrom: method<{ path: string; from: string }, MergeResult>({ mutates: true, timeoutMs: NETWORK_MS }),

    // Pull requests
    createPr: method<{ path: string; branch: string }, CreatePrResult>({ mutates: true, timeoutMs: NETWORK_MS }),
    prStatus: method<{ path: string; branch: string }, PrStatusResult | null>(),
    prList: method<AtCwd, PrSummary[]>(),
    /** Head ref and fetched base of a PR in the root's github.com repository;
     *  null when the root's origin is another repository. */
    prContext: method<{ repository: string; number: number }, PullRequestContext | null>({ mutates: true, timeoutMs: 150_000 }),

    // GitHub account (the host's `gh` login)
    githubConnection: method<void, GitHubConnection>(),
    /** `start` begins a device-code login for this connection, `cancel` stops
     *  it, `state` reads it. */
    githubLogin: method<{ operation: 'start' | 'cancel' | 'state' }, GitHubLoginState>({ mutates: true }),
    /** The signed-in account's open PRs and review requests (cached 60 s). */
    pullRequests: method<{ refresh?: boolean }, PullRequestsResult>({ timeoutMs: NETWORK_MS }),
  },
  streams: {
    /** One checkout's status: a snapshot, then the whole status after every
     *  change. The runtime polls (adaptive, 2 s to 30 s) and watches files
     *  while anyone is subscribed. */
    status: channelStream<AtCwd, RepoStatus, RepoStatus>(),
  },
})

export type VcsCapability = typeof vcsCapability

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    vcs: typeof vcsCapability
  }
}
