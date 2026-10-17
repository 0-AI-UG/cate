// GitHub through the `gh` CLI on the runtime's host: connection state, the
// signed-in account's pull requests, and remote URL helpers.

export interface PullRequestItem {
  id: string
  number: number
  title: string
  url: string
  repository: string
  author: string
  updatedAt: string
  additions: number
  deletions: number
  draft: boolean
  checks: string | null
  involvement: 'authored' | 'review'
}

export type PullRequestsResult =
  | { status: 'ready'; account: string; items: PullRequestItem[]; truncated: boolean }
  | { status: 'missing-cli' | 'signed-out' | 'error'; message: string }

export interface GitHubLoginState {
  status: 'idle' | 'pending' | 'complete' | 'error'
  code?: string
  message?: string
}

export interface GitHubConnection {
  status: 'connected' | 'signed-out' | 'missing-cli' | 'error'
  account?: string
  version?: string
  message?: string
}

export interface PullRequestContext {
  headRefName: string
  baseOid: string
}

/** Convert a GitHub fetch/push remote into a credential-free browser URL. */
export function githubRepositoryUrl(remote: string): string | null {
  const match = remote.trim().match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  return match ? `https://github.com/${match[1]}/${match[2]}` : null
}

/** `owner/name`, lowercased, for a github.com remote; null for anything else. */
export function githubRepository(remote: string): string | null {
  return remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i)?.[1]?.toLowerCase() ?? null
}

const fields = `id number title url updatedAt additions deletions isDraft
  repository { nameWithOwner } author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

export const PR_QUERY = `query($authored: String!, $review: String!) {
  viewer { login }
  authored: search(query: $authored, type: ISSUE, first: 100) { pageInfo { hasNextPage } nodes { ... on PullRequest { ${fields} } } }
  review: search(query: $review, type: ISSUE, first: 100) { pageInfo { hasNextPage } nodes { ... on PullRequest { ${fields} } } }
}`

interface PrNode {
  id: string; number: number; title: string; url: string; updatedAt: string; additions: number; deletions: number; isDraft: boolean
  repository: { nameWithOwner: string }; author: { login: string } | null
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

export interface PullRequestsPayload {
  data?: {
    viewer: { login: string }
    authored: { nodes: PrNode[]; pageInfo: { hasNextPage: boolean } }
    review: { nodes: PrNode[]; pageInfo: { hasNextPage: boolean } }
  }
  errors?: unknown[]
}

export function parsePullRequests(payload: PullRequestsPayload): PullRequestsResult {
  if (payload.errors?.length || !payload.data) throw new Error('GitHub could not return the full pull request list.')
  const data = payload.data
  const seen = new Set<string>()
  const items: PullRequestItem[] = []
  for (const involvement of ['authored', 'review'] as const) {
    for (const pr of data[involvement].nodes) {
      if (!pr?.id || seen.has(pr.id)) continue
      seen.add(pr.id)
      items.push({
        id: pr.id, number: pr.number, title: pr.title, url: pr.url, repository: pr.repository.nameWithOwner,
        author: pr.author?.login ?? 'Deleted account', updatedAt: pr.updatedAt, additions: pr.additions, deletions: pr.deletions,
        draft: pr.isDraft, checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null, involvement,
      })
    }
  }
  return { status: 'ready', account: data.viewer.login, items, truncated: data.authored.pageInfo.hasNextPage || data.review.pageInfo.hasNextPage }
}
