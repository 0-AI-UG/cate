import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { getShellEnv } from '../shellEnv'
import type { GitHubLoginState, PullRequestItem, PullRequestsResult } from '../../shared/pullRequests'

const exec = promisify(execFile)
async function gh(args: string[]): Promise<string> {
  return (await exec('gh', args, { cwd: os.homedir(), env: getShellEnv(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout
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
export function parsePullRequests(payload: { data?: {
  viewer: { login: string }
  authored: { nodes: PrNode[]; pageInfo: { hasNextPage: boolean } }
  review: { nodes: PrNode[]; pageInfo: { hasNextPage: boolean } }
}; errors?: unknown[] }): PullRequestsResult {
  if (payload.errors?.length || !payload.data) throw new Error('GitHub could not return the full pull request list.')
  const data = payload.data
  const seen = new Set<string>()
  const items: PullRequestItem[] = []
  for (const involvement of ['authored', 'review'] as const) {
    for (const pr of data[involvement].nodes) {
      if (!pr?.id || seen.has(pr.id)) continue
      seen.add(pr.id)
      items.push({ id: pr.id, number: pr.number, title: pr.title, url: pr.url, repository: pr.repository.nameWithOwner,
        author: pr.author?.login ?? 'Deleted account', updatedAt: pr.updatedAt, additions: pr.additions, deletions: pr.deletions,
        draft: pr.isDraft, checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null, involvement })
    }
  }
  return { status: 'ready', account: data.viewer.login, items, truncated: data.authored.pageInfo.hasNextPage || data.review.pageInfo.hasNextPage }
}

let cached: { at: number; result: PullRequestsResult } | undefined
let pending: Promise<PullRequestsResult> | undefined
export async function listPullRequests(refresh = false): Promise<PullRequestsResult> {
  if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.result
  if (pending) return pending
  pending = (async (): Promise<PullRequestsResult> => {
    try {
      await gh(['--version'])
    } catch (error) {
      return { status: 'missing-cli', message: 'Install GitHub CLI to connect your GitHub account.' }
    }
    try {
      await gh(['auth', 'status', '--hostname', 'github.com'])
    } catch {
      return { status: 'signed-out', message: 'Sign in to GitHub to see your pull requests and review requests.' }
    }
    try {
      const account = (await gh(['api', '--hostname', 'github.com', 'user', '--jq', '.login'])).trim()
      const payload = JSON.parse(await gh(['api', '--hostname', 'github.com', 'graphql', '-f', `query=${PR_QUERY}`,
        '-f', `authored=is:pr is:open author:${account} sort:updated-desc`,
        '-f', `review=is:pr is:open review-requested:${account} sort:updated-desc`]))
      const result = parsePullRequests(payload)
      cached = { at: Date.now(), result }
      return result
    } catch {
      return { status: 'error', message: 'Could not load pull requests from GitHub. Check your connection and try again.' }
    }
  })().finally(() => { pending = undefined })
  return pending
}

const logins = new Map<number, { state: GitHubLoginState; child?: ChildProcess; timer?: ReturnType<typeof setTimeout> }>()
export function githubLoginState(owner: number): GitHubLoginState {
  return logins.get(owner)?.state ?? { status: 'idle' }
}
export function cancelGithubLogin(owner: number): void {
  const login = logins.get(owner)
  if (login?.timer) clearTimeout(login.timer)
  login?.child?.kill()
  logins.delete(owner)
}
export function startGithubLogin(owner: number): GitHubLoginState {
  if (logins.get(owner)?.state.status === 'pending') return githubLoginState(owner)
  cancelGithubLogin(owner)
  const login: { state: GitHubLoginState; child?: ChildProcess; timer?: ReturnType<typeof setTimeout> } = { state: { status: 'pending' } }
  logins.set(owner, login)
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--web'], {
    cwd: os.homedir(), env: getShellEnv(), windowsHide: true, stdio: 'pipe',
  })
  login.child = child
  let output = ''
  const onData = (data: Buffer) => {
    output = (output + data.toString()).slice(-4096)
    const code = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1]
    if (code && !login.state.code) {
      login.state = { status: 'pending', code }
      child.stdin?.write('\n')
    }
  }
  child.stdin?.on('error', () => { /* The login process may exit before consuming Enter. */ })
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', () => {
    if (login.timer) clearTimeout(login.timer)
    login.state = { status: 'error', message: 'Could not start GitHub CLI. Install gh and try again.' }
  })
  child.on('close', (code) => {
    if (login.timer) clearTimeout(login.timer)
    cached = undefined
    login.state = code === 0 ? { status: 'complete' } : { status: 'error', message: 'GitHub sign-in did not complete. Try again.' }
  })
  login.timer = setTimeout(() => { child.kill() }, 10 * 60_000)
  return login.state
}


export async function githubConnection(): Promise<import('../../shared/pullRequests').GitHubConnection> {
  let version: string
  try { version = (await gh(['--version'])).split('\n')[0].trim() }
  catch { return { status: 'missing-cli', message: 'Install GitHub CLI to connect GitHub.' } }
  try { await gh(['auth', 'status', '--hostname', 'github.com']) }
  catch { return { status: 'signed-out', version, message: 'Sign in to connect your GitHub account.' } }
  try {
    const account = (await gh(['api', '--hostname', 'github.com', 'user', '--jq', '.login'])).trim()
    return { status: 'connected', version, account }
  } catch { return { status: 'error', version, message: 'Could not verify your GitHub account. Check your connection and retry.' } }
}

export function githubRepository(remote: string): string | null {
  return remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i)?.[1]?.toLowerCase() ?? null
}

// The IPC handler validates this root against the requesting workspace first.
export async function pullRequestContext(root: string, repository: string, number: number): Promise<import('../../shared/pullRequests').PullRequestContext | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request')
  const options = { cwd: root, env: getShellEnv(), timeout: 120_000, windowsHide: true }
  let remote: string
  try { remote = (await exec('git', ['remote', 'get-url', 'origin'], options)).stdout }
  catch { return null }
  if (githubRepository(remote) !== repository.toLowerCase()) return null
  const data = JSON.parse((await exec('gh', ['pr', 'view', String(number), '--repo', repository, '--json', 'headRefName,baseRefOid'], options)).stdout)
  if (typeof data.headRefName !== 'string' || !/^[a-f0-9]{40,64}$/.test(data.baseRefOid)) throw new Error('GitHub returned invalid pull request details')
  await exec('git', ['fetch', 'origin', data.baseRefOid], options)
  return { headRefName: data.headRefName, baseOid: data.baseRefOid }
}
