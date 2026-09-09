import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { getShellEnv } from '../shellEnv'

const exec = promisify(execFile)

export async function gh(args: string[]): Promise<string> {
  return (await exec('gh', args, { cwd: os.homedir(), env: getShellEnv(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout
}

/** Resolve the same github.com credentials as Cate's GitHub CLI login.
 * Keep credentials in the main process and resolve afresh to follow account changes. */
export async function getGithubToken(): Promise<string | undefined> {
  const env = getShellEnv()
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  if (token) return token
  try {
    return (await gh(['auth', 'token', '--hostname', 'github.com'])).trim() || undefined
  } catch {
    // Public skills remain available without gh or a signed-in account.
    return undefined
  }
}
