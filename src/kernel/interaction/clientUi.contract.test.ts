import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, it } from 'vitest'

// Panel contract rule 6 (docs/architecture.md 11.2): only views reach the
// user, and only through ClientUi, so the same code runs behind any client
// shell. Shells implement the port; nothing else opens native dialogs or drives
// the OS shell. Sessions and runtime code never ask the user at all.
const ROOT = join(__dirname, '../../..')
const SRC = join(ROOT, 'src')
const PORTABLE_ROOTS = ['kernel', 'runtime', 'workspace', 'services', 'client', 'panels']
const NATIVE = [
  /\bwindow\.(confirm|alert|prompt)\(/,
  /navigator\.clipboard\./,
]
const CLIENT_UI_CALL = /\bclientUi\(\)/

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

function offenders(files: string[], patterns: RegExp[]): string[] {
  return files.flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
    patterns.some(pattern => pattern.test(line)) ? [`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`] : []))
}

const segments = (file: string): string[] => relative(SRC, file).split(sep)

it('only the ClientUi port makes native user-facing calls', () => {
  // Desktop sides and shells are where the port is implemented.
  const files = PORTABLE_ROOTS.flatMap(root => sourceFiles(join(SRC, root)))
    .filter(file => !segments(file).includes('desktop'))
  expect(offenders(files, NATIVE)).toEqual([])
})

it('sessions and runtime code never call clientUi()', () => {
  const files = sourceFiles(SRC).filter((file) => {
    const parts = segments(file)
    // A shell's `ui/runtime/` holds the views of the runtime module: UI.
    if (parts[0] === 'shells') return false
    return parts[parts.length - 1] === 'session.ts' || parts.slice(0, -1).includes('runtime')
  })
  expect(files.length).toBeGreaterThan(0)
  expect(offenders(files, [CLIENT_UI_CALL])).toEqual([])
})
