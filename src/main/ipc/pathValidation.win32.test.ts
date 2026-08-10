import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const realpathMocks = vi.hoisted(() => {
  const native = vi.fn<(path: string) => string>()
  const fallback = Object.assign(vi.fn<(path: string) => string>(), { native })
  return { native, fallback }
})

vi.mock('fs', () => ({ default: { realpathSync: realpathMocks.fallback } }))
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { default: actual.win32 }
})
vi.mock('os', () => ({ default: { tmpdir: () => 'C:\\Temp' } }))

const { addAllowedRoot, removeAllowedRoot, validatePath } = await import('./pathValidation')

describe('pathValidation on win32 network paths', () => {
  const SCOPE = 'mapped-drive'

  beforeEach(() => {
    realpathMocks.native.mockImplementation((value) => value)
    realpathMocks.fallback.mockImplementation((value) => value)
  })

  afterEach(() => {
    removeAllowedRoot('X:\\project', SCOPE)
    removeAllowedRoot('X:\\', SCOPE)
    removeAllowedRoot('\\\\server\\share\\', SCOPE)
    vi.clearAllMocks()
  })

  test('accepts both drive-letter and UNC forms of a canonicalized root', () => {
    realpathMocks.native.mockImplementation((value) =>
      value === 'X:\\project' ? '\\\\server\\share\\project' : value,
    )
    addAllowedRoot('X:\\project', SCOPE)

    expect(validatePath('X:\\project\\src\\index.ts', undefined, SCOPE)).toBe(
      'X:\\project\\src\\index.ts',
    )
    expect(validatePath('\\\\server\\share\\project\\src\\index.ts', undefined, SCOPE)).toBe(
      '\\\\server\\share\\project\\src\\index.ts',
    )
  })

  test.each(['X:\\', '\\\\server\\share\\'])('accepts children when the root already ends in a separator: %s', (root) => {
    addAllowedRoot(root, SCOPE)
    const child = root + 'folder\\file.txt'
    expect(validatePath(child, undefined, SCOPE)).toBe(child)
  })
})
