import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'

// targets.ts → agentDir.ts imports `app` from electron. Stub it (only getPath is
// touched, and not by the path helpers under test).
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { skillsRootDir } from './targets'

describe('skillsRootDir', () => {
  const cwd = '/home/u/proj'

  it('maps each target to its workspace-relative skills dir (local)', () => {
    // Local paths use native separators, so build the expected value with
    // path.join to keep this assertion correct on Windows too.
    expect(skillsRootDir('claude-code', 'local', cwd)).toBe(path.join(cwd, '.claude', 'skills'))
    expect(skillsRootDir('cate-agent', 'local', cwd)).toBe(path.join(cwd, '.cate', 'pi-agent', 'skills'))
    expect(skillsRootDir('pi-native', 'local', cwd)).toBe(path.join(cwd, '.agents', 'skills'))
    expect(skillsRootDir('opencode', 'local', cwd)).toBe(path.join(cwd, '.opencode', 'skills'))
    expect(skillsRootDir('codex', 'local', cwd)).toBe(path.join(cwd, '.codex', 'skills'))
    expect(skillsRootDir('antigravity', 'local', cwd)).toBe(path.join(cwd, '.agent', 'skills'))
  })

  it('uses POSIX joins for a remote companion', () => {
    expect(skillsRootDir('claude-code', 'srv_1', '/srv/work')).toBe('/srv/work/.claude/skills')
  })
})
