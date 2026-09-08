import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }))
vi.mock('../shellEnv', () => ({ getShellEnv: () => ({ PATH: '/test/bin' }) }))
vi.mock('node:child_process', () => ({ execFile: mocks.exec, spawn: mocks.spawn }))
import { cancelGithubLogin, githubLoginState, startGithubLogin, listPullRequests, parsePullRequests } from './pullRequests'
const pr = { id: 'PR_1', number: 42, title: 'Fix startup', url: 'https://github.com/org/repo/pull/42', updatedAt: '2026-09-08T10:00:00Z', additions: 20, deletions: 3, isDraft: false, repository: { nameWithOwner: 'org/repo' }, author: null, commits: { nodes: [] } }
const payload = { data: { viewer: { login: 'alice' }, authored: { nodes: [pr], pageInfo: { hasNextPage: false } }, review: { nodes: [pr], pageInfo: { hasNextPage: true } } } }
beforeEach(() => { mocks.exec.mockReset() })
it('deduplicates groups, handles deleted authors and missing checks, and reports pagination', () => {
  const result = parsePullRequests(payload)
  expect(result).toMatchObject({ status: 'ready', account: 'alice', truncated: true, items: [{ id: 'PR_1', author: 'Deleted account', checks: null, involvement: 'authored' }] })
  if (result.status === 'ready') expect(result.items).toHaveLength(1)
})
it('rejects partial GraphQL results instead of presenting incomplete totals', () => {
  expect(() => parsePullRequests({ ...payload, errors: [{ message: 'Rate limited' }] })).toThrow('full pull request list')
})
it('reports missing gh without attempting authentication or API calls', async () => {
  mocks.exec.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error('ENOENT')))
  expect(await listPullRequests(true)).toMatchObject({ status: 'missing-cli' })
  expect(mocks.exec).toHaveBeenCalledTimes(1)
})
it('reports signed-out accounts without fetching pull requests', async () => {
  mocks.exec.mockImplementation((_cmd, args, _opts, callback) => args[0] === '--version' ? callback(null, 'gh 2.96', '') : callback(new Error('Not logged in')))
  expect(await listPullRequests(true)).toMatchObject({ status: 'signed-out' })
  expect(mocks.exec).toHaveBeenCalledTimes(2)
})

function fakeLogin() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { write: vi.fn() }), kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
  return child
}
it('exposes only the device code and advances the browser flow once', () => {
  const child = fakeLogin()
  expect(startGithubLogin(1)).toEqual({ status: 'pending' })
  child.stderr.emit('data', Buffer.from('First copy your one-time code: ABCD-'))
  child.stderr.emit('data', Buffer.from('1234\n'))
  expect(githubLoginState(1)).toEqual({ status: 'pending', code: 'ABCD-1234' })
  child.stderr.emit('data', Buffer.from('Press Enter to open github.com'))
  expect(child.stdin.write).toHaveBeenCalledExactlyOnceWith('\n')
  child.emit('close', 0)
  expect(githubLoginState(1)).toEqual({ status: 'complete' })
  cancelGithubLogin(1)
})
it('cancels only the requesting window login', () => {
  const child = fakeLogin()
  startGithubLogin(2)
  expect(githubLoginState(3)).toEqual({ status: 'idle' })
  cancelGithubLogin(3)
  expect(child.kill).not.toHaveBeenCalled()
  cancelGithubLogin(2)
  expect(child.kill).toHaveBeenCalledOnce()
  expect(githubLoginState(2)).toEqual({ status: 'idle' })
})

it('recognizes GitHub remotes without accepting lookalike hosts', async () => {
  const { githubRepository } = await import('./pullRequests')
  for (const remote of ['git@github.com:Org/Repo.git', 'https://github.com/Org/Repo.git', 'ssh://git@github.com/Org/Repo']) expect(githubRepository(remote)).toBe('org/repo')
  expect(githubRepository('https://github.com.evil.test/org/repo')).toBeNull()
})
it('reports account and version independently of the pull request API', async () => {
  const { githubConnection } = await import('./pullRequests')
  mocks.exec.mockImplementation((_cmd, args, _opts, callback) => callback(null, { stdout: args[0] === '--version' ? 'gh version 2.96.0\nrelease notes' : args[0] === 'api' ? 'alice\n' : '' }))
  expect(await githubConnection()).toEqual({ status: 'connected', version: 'gh version 2.96.0', account: 'alice' })
  expect(mocks.exec.mock.calls.some((call) => call[1].includes('graphql'))).toBe(false)
})
it('does not fetch or check out a PR in a different repository', async () => {
  const { pullRequestContext } = await import('./pullRequests')
  mocks.exec.mockImplementation((_cmd, _args, _opts, callback) => callback(null, { stdout: 'git@github.com:other/repo.git' }))
  expect(await pullRequestContext('/project', 'org/repo', 42)).toBeNull()
  expect(mocks.exec).toHaveBeenCalledTimes(1)
})
it('fetches the PR base without changing the current branch', async () => {
  const { pullRequestContext } = await import('./pullRequests')
  const baseOid = 'a'.repeat(40)
  mocks.exec.mockImplementation((cmd, args, _opts, callback) => callback(null, { stdout: cmd === 'gh' ? JSON.stringify({ headRefName: 'feature', baseRefOid: baseOid }) : args[0] === 'remote' ? 'https://github.com/org/repo.git' : '' }))
  expect(await pullRequestContext('/project', 'org/repo', 42)).toEqual({ headRefName: 'feature', baseOid })
  expect(mocks.exec.mock.calls.map((call) => call[1])).toEqual([
    ['remote', 'get-url', 'origin'], ['pr', 'view', '42', '--repo', 'org/repo', '--json', 'headRefName,baseRefOid'], ['fetch', 'origin', baseOid],
  ])
})
