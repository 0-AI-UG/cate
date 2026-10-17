import os from 'node:os'
import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), env: {} as NodeJS.ProcessEnv }))
vi.mock('node:child_process', () => ({ execFile: mocks.exec, spawn: mocks.spawn }))

import { createGithubHost } from './github'
import { githubRepository, githubRepositoryUrl, parsePullRequests } from '../contract'

const host = () => createGithubHost({ env: () => mocks.env })

const pr = { id: 'PR_1', number: 42, title: 'Fix startup', url: 'https://github.com/org/repo/pull/42', updatedAt: '2026-09-08T10:00:00Z', additions: 20, deletions: 3, isDraft: false, repository: { nameWithOwner: 'org/repo' }, author: null, commits: { nodes: [] } }
const payload = { data: { viewer: { login: 'alice' }, authored: { nodes: [pr], pageInfo: { hasNextPage: false } }, review: { nodes: [pr], pageInfo: { hasNextPage: true } } } }

beforeEach(() => {
  mocks.exec.mockReset()
  mocks.spawn.mockReset()
  mocks.env = { PATH: '/test/bin' }
})

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
  expect(await host().pullRequests(true)).toMatchObject({ status: 'missing-cli' })
  expect(mocks.exec).toHaveBeenCalledTimes(1)
})

it('reports signed-out accounts without fetching pull requests', async () => {
  mocks.exec.mockImplementation((_cmd, args, _opts, callback) => args[0] === '--version' ? callback(null, 'gh 2.96', '') : callback(new Error('Not logged in')))
  expect(await host().pullRequests(true)).toMatchObject({ status: 'signed-out' })
  expect(mocks.exec).toHaveBeenCalledTimes(2)
})

function fakeLogin() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { write: vi.fn() }), kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
  return child
}

it('exposes only the device code and advances the browser flow once', () => {
  const gh = host()
  const child = fakeLogin()
  expect(gh.startLogin(1)).toEqual({ status: 'pending' })
  child.stderr.emit('data', Buffer.from('First copy your one-time code: ABCD-'))
  child.stderr.emit('data', Buffer.from('1234\n'))
  expect(gh.loginState(1)).toEqual({ status: 'pending', code: 'ABCD-1234' })
  child.stderr.emit('data', Buffer.from('Press Enter to open github.com'))
  expect(child.stdin.write).toHaveBeenCalledExactlyOnceWith('\n')
  child.emit('close', 0)
  expect(gh.loginState(1)).toEqual({ status: 'complete' })
  gh.cancelLogin(1)
})

it('cancels only the requesting connection login', () => {
  const gh = host()
  const child = fakeLogin()
  gh.startLogin(2)
  expect(gh.loginState(3)).toEqual({ status: 'idle' })
  gh.cancelLogin(3)
  expect(child.kill).not.toHaveBeenCalled()
  gh.cancelLogin(2)
  expect(child.kill).toHaveBeenCalledOnce()
  expect(gh.loginState(2)).toEqual({ status: 'idle' })
})

it('recognizes GitHub remotes without accepting lookalike hosts', () => {
  for (const remote of ['git@github.com:Org/Repo.git', 'https://github.com/Org/Repo.git', 'ssh://git@github.com/Org/Repo']) expect(githubRepository(remote)).toBe('org/repo')
  expect(githubRepository('https://github.com.evil.test/org/repo')).toBeNull()
})

it.each(['git@github.com:org/repo.git', 'ssh://git@github.com/org/repo.git', 'https://github.com/org/repo.git', 'https://token@github.com/org/repo'])('creates a credential-free GitHub link for %s', (remote) => {
  expect(githubRepositoryUrl(remote)).toBe('https://github.com/org/repo')
})

it.each(['https://github.com.evil.com/org/repo', 'javascript:alert(1)', '/local/repo', 'https://github.com/org/repo?token=secret'])('does not turn %s into a GitHub link', (remote) => {
  expect(githubRepositoryUrl(remote)).toBeNull()
})

it('reports account and version independently of the pull request API', async () => {
  mocks.exec.mockImplementation((_cmd, args, _opts, callback) => callback(null, { stdout: args[0] === '--version' ? 'gh version 2.96.0\nrelease notes' : args[0] === 'api' ? 'alice\n' : '' }))
  expect(await host().connection()).toEqual({ status: 'connected', version: 'gh version 2.96.0', account: 'alice' })
  expect(mocks.exec.mock.calls.some((call) => call[1].includes('graphql'))).toBe(false)
})

it('does not fetch or check out a PR in a different repository', async () => {
  mocks.exec.mockImplementation((_cmd, _args, _opts, callback) => callback(null, { stdout: 'git@github.com:other/repo.git' }))
  expect(await host().pullRequestContext('/project', 'org/repo', 42)).toBeNull()
  expect(mocks.exec).toHaveBeenCalledTimes(1)
})

it('fetches the PR base without changing the current branch', async () => {
  const baseOid = 'a'.repeat(40)
  mocks.exec.mockImplementation((cmd, args, _opts, callback) => callback(null, { stdout: cmd === 'gh' ? JSON.stringify({ headRefName: 'feature', baseRefOid: baseOid }) : args[0] === 'remote' ? 'https://github.com/org/repo.git' : '' }))
  expect(await host().pullRequestContext('/project', 'org/repo', 42)).toEqual({ headRefName: 'feature', baseOid })
  expect(mocks.exec.mock.calls.map((call) => call[1])).toEqual([
    ['remote', 'get-url', 'origin'], ['pr', 'view', '42', '--repo', 'org/repo', '--json', 'headRefName,baseRefOid'], ['fetch', 'origin', baseOid],
  ])
})

it('reads the active github.com account token and follows account changes', async () => {
  mocks.exec.mockImplementationOnce((_cmd, _args, _opts, callback) => callback(null, { stdout: 'first-token\n' }))
    .mockImplementationOnce((_cmd, _args, _opts, callback) => callback(null, { stdout: 'second-token\n' }))
  const gh = host()
  expect(await gh.token()).toBe('first-token')
  expect(await gh.token()).toBe('second-token')
  expect(mocks.exec).toHaveBeenCalledWith('gh', ['auth', 'token', '--hostname', 'github.com'],
    expect.objectContaining({ cwd: os.homedir(), env: mocks.env, timeout: 30_000 }), expect.any(Function))
})

it('matches GitHub CLI environment token precedence', async () => {
  mocks.env.GH_TOKEN = 'gh-token'
  mocks.env.GITHUB_TOKEN = 'github-token'
  expect(await host().token()).toBe('gh-token')
  delete mocks.env.GH_TOKEN
  expect(await host().token()).toBe('github-token')
  expect(mocks.exec).not.toHaveBeenCalled()
})

it.each(['ENOENT', 'not logged in'])('allows anonymous requests when gh reports %s', async (message) => {
  mocks.exec.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error(message)))
  expect(await host().token()).toBeUndefined()
})
