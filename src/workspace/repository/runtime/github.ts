// GitHub through the host's `gh` login: connection state, the account's pull
// requests, device-code sign-in and PR context for a repository.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import {
  githubRepository,
  parsePullRequests,
  PR_QUERY,
  type GitHubConnection,
  type GitHubLoginState,
  type PullRequestContext,
  type PullRequestsResult,
} from '../contract'

const exec = promisify(execFile)

export interface GithubHost {
  connection(): Promise<GitHubConnection>
  pullRequests(refresh?: boolean): Promise<PullRequestsResult>
  /** Logins are per owner (a client connection). */
  loginState(owner: number): GitHubLoginState
  startLogin(owner: number): GitHubLoginState
  cancelLogin(owner: number): void
  /** `root` must already be validated against the workspace. */
  pullRequestContext(root: string, repository: string, number: number): Promise<PullRequestContext | null>
  /** The github.com token `gh` would use, for anonymous-tolerant API calls. */
  token(): Promise<string | undefined>
  dispose(): void
}

interface Login {
  state: GitHubLoginState
  child?: ChildProcess
  timer?: ReturnType<typeof setTimeout>
}

export function createGithubHost(deps: { env: () => NodeJS.ProcessEnv }): GithubHost {
  const gh = async (args: string[]): Promise<string> =>
    (await exec('gh', args, { cwd: os.homedir(), env: deps.env(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout

  let cached: { at: number; result: PullRequestsResult } | undefined
  let pending: Promise<PullRequestsResult> | undefined
  const logins = new Map<number, Login>()

  const host: GithubHost = {
    async connection() {
      let version: string
      try { version = (await gh(['--version'])).split('\n')[0].trim() }
      catch { return { status: 'missing-cli', message: 'Install GitHub CLI to connect GitHub.' } }
      try { await gh(['auth', 'status', '--hostname', 'github.com']) }
      catch { return { status: 'signed-out', version, message: 'Sign in to connect your GitHub account.' } }
      try {
        const account = (await gh(['api', '--hostname', 'github.com', 'user', '--jq', '.login'])).trim()
        return { status: 'connected', version, account }
      } catch {
        return { status: 'error', version, message: 'Could not verify your GitHub account. Check your connection and retry.' }
      }
    },

    async pullRequests(refresh = false) {
      if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.result
      if (pending) return pending
      pending = (async (): Promise<PullRequestsResult> => {
        try {
          await gh(['--version'])
        } catch {
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
    },

    loginState(owner) {
      return logins.get(owner)?.state ?? { status: 'idle' }
    },

    cancelLogin(owner) {
      const login = logins.get(owner)
      if (login?.timer) clearTimeout(login.timer)
      login?.child?.kill()
      logins.delete(owner)
    },

    startLogin(owner) {
      if (logins.get(owner)?.state.status === 'pending') return host.loginState(owner)
      host.cancelLogin(owner)
      const login: Login = { state: { status: 'pending' } }
      logins.set(owner, login)
      const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--web'], {
        cwd: os.homedir(), env: deps.env(), windowsHide: true, stdio: 'pipe',
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
      child.stdin?.on('error', () => { /* gh may exit before reading Enter */ })
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
    },

    async pullRequestContext(root, repository, number) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request')
      const options = { cwd: root, env: deps.env(), timeout: 120_000, windowsHide: true }
      let remote: string
      try { remote = (await exec('git', ['remote', 'get-url', 'origin'], options)).stdout }
      catch { return null }
      if (githubRepository(remote) !== repository.toLowerCase()) return null
      const data = JSON.parse((await exec('gh', ['pr', 'view', String(number), '--repo', repository, '--json', 'headRefName,baseRefOid'], options)).stdout)
      if (typeof data.headRefName !== 'string' || !/^[a-f0-9]{40,64}$/.test(data.baseRefOid)) throw new Error('GitHub returned invalid pull request details')
      await exec('git', ['fetch', 'origin', data.baseRefOid], options)
      return { headRefName: data.headRefName, baseOid: data.baseRefOid }
    },

    async token() {
      const env = deps.env()
      const token = env.GH_TOKEN || env.GITHUB_TOKEN
      if (token) return token
      try {
        return (await gh(['auth', 'token', '--hostname', 'github.com'])).trim() || undefined
      } catch {
        return undefined
      }
    },

    dispose() {
      for (const owner of [...logins.keys()]) host.cancelLogin(owner)
    },
  }
  return host
}
