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
