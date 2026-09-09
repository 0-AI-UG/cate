import { expect, it } from 'vitest'
import { githubRepositoryUrl } from './gitRemote'
it.each(['git@github.com:org/repo.git', 'ssh://git@github.com/org/repo.git', 'https://github.com/org/repo.git', 'https://token@github.com/org/repo'])('creates a credential-free GitHub link for %s', remote => {
  expect(githubRepositoryUrl(remote)).toBe('https://github.com/org/repo')
})
it.each(['https://github.com.evil.com/org/repo', 'javascript:alert(1)', '/local/repo', 'https://github.com/org/repo?token=secret'])('does not turn %s into a GitHub link', remote => {
  expect(githubRepositoryUrl(remote)).toBeNull()
})
