// Test helper: a git host whose path scope accepts any directory.
import { createGitHost, type GitHost } from './git'

export function testGitHost(env: () => NodeJS.ProcessEnv = () => process.env): GitHost {
  return createGitHost({
    env,
    resolveDir: (dir) => {
      if (!dir) throw new Error('test git host needs an explicit cwd')
      return dir
    },
    addCheckout: () => {},
    removeCheckout: () => {},
  })
}
