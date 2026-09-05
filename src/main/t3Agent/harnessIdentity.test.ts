import path from 'path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_NODE_EXECUTABLE } from '../runtime/types'
import { harnessKey, harnessNodeExecutable, harnessPaths, partitionFor } from './harnessIdentity'

describe('T3 harness identity', () => {
  it('keys one harness per runtime and canonical cwd', () => {
    expect(harnessKey('local', '/repo')).toBe(harnessKey('local', '/repo'))
    expect(harnessKey('remote-a', '/repo')).not.toBe(harnessKey('remote-b', '/repo'))
    expect(harnessKey('local', '/repo')).not.toBe(harnessKey('local', '/repo-worktree'))
  })

  it('uses host-native local paths and POSIX remote paths', () => {
    const local = harnessPaths('local', path.join('/tmp', 'extensions'), path.join('/tmp', 'repo'))
    const remote = harnessPaths('remote-a', '/home/user/.cate/extensions/.cate-t3', '/work/repo')

    expect(local.baseDir.startsWith(local.instancesRoot + path.sep)).toBe(true)
    expect(remote.baseDir).toMatch(/^\/home\/user\/\.cate\/extensions\/\.cate-t3\/instances\/[a-f0-9]{16}$/)
    expect(remote.providerProfilePath).toBe('/home/user/.cate/extensions/.cate-t3/provider-profile.json')
  })

  it('gives each harness a stable isolated browser partition', () => {
    expect(partitionFor(harnessKey('local', '/repo'))).toBe(partitionFor(harnessKey('local', '/repo')))
    expect(partitionFor(harnessKey('local', '/repo'))).not.toBe(partitionFor(harnessKey('local', '/other')))
  })

  it('uses the development Node only for an unpackaged local harness', () => {
    const devNode = '/opt/dev/bin/node'

    expect(harnessNodeExecutable('local', false, devNode)).toBe(devNode)
    expect(harnessNodeExecutable('local', true, devNode)).toBe(RUNTIME_NODE_EXECUTABLE)
    expect(harnessNodeExecutable('remote-a', false, devNode)).toBe(RUNTIME_NODE_EXECUTABLE)
  })

  it('falls back to PATH lookup when npm did not publish its Node path', () => {
    expect(harnessNodeExecutable('local', false, '  ')).toBe('node')
  })
})
