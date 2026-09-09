import os from 'node:os'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), env: {} as NodeJS.ProcessEnv }))
vi.mock('node:child_process', () => ({ execFile: mocks.exec }))
vi.mock('../shellEnv', () => ({ getShellEnv: () => mocks.env }))

import { getGithubToken } from './cli'

beforeEach(() => {
  mocks.exec.mockReset()
  mocks.env = { PATH: '/test/bin' }
})

it('reads the active github.com account and follows account changes', async () => {
  mocks.exec.mockImplementationOnce((_cmd, _args, _opts, callback) => callback(null, { stdout: 'first-token\n' }))
    .mockImplementationOnce((_cmd, _args, _opts, callback) => callback(null, { stdout: 'second-token\n' }))
  expect(await getGithubToken()).toBe('first-token')
  expect(await getGithubToken()).toBe('second-token')
  expect(mocks.exec).toHaveBeenCalledWith('gh', ['auth', 'token', '--hostname', 'github.com'],
    expect.objectContaining({ cwd: os.homedir(), env: mocks.env, timeout: 30_000 }), expect.any(Function))
})

it('matches GitHub CLI environment token precedence', async () => {
  mocks.env.GH_TOKEN = 'gh-token'
  mocks.env.GITHUB_TOKEN = 'github-token'
  expect(await getGithubToken()).toBe('gh-token')
  delete mocks.env.GH_TOKEN
  expect(await getGithubToken()).toBe('github-token')
  expect(mocks.exec).not.toHaveBeenCalled()
})

it.each(['ENOENT', 'not logged in'])('allows anonymous requests when gh reports %s', async (message) => {
  mocks.exec.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error(message)))
  expect(await getGithubToken()).toBeUndefined()
})

it('treats an empty token as signed out', async () => {
  mocks.exec.mockImplementation((_cmd, _args, _opts, callback) => callback(null, { stdout: '\n' }))
  expect(await getGithubToken()).toBeUndefined()
})
