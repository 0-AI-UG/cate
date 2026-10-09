// The dependency rules reject what they must: depcruise runs over
// test/depcruise-fixtures, where each fixture file breaks one rule.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')
const fixtures = path.join(root, 'test/depcruise-fixtures')

let rejected: Set<string>

beforeAll(() => {
  let out: string
  try {
    out = execFileSync(path.join(root, 'node_modules/.bin/depcruise'),
      ['src', '--config', path.join(root, '.dependency-cruiser.cjs'), '--output-type', 'json'],
      { cwd: fixtures, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    // depcruise exits non-zero when it finds violations; the report is on stdout.
    out = (error as { stdout: string }).stdout
  }
  const report = JSON.parse(out) as { summary: { violations: { from: string }[] } }
  rejected = new Set(report.summary.violations.map((violation) => violation.from))
}, 60_000)

describe('dependency rules', () => {
  it('a runtime side importing a client side', () => {
    expect(rejected).toContain('src/workspace/files/runtime/bad.ts')
  })
  it('a panel session importing the client core', () => {
    expect(rejected).toContain('src/panels/fake/session.ts')
  })
  it('a panel definition importing a Node built-in', () => {
    expect(rejected).toContain('src/panels/fake/definition.ts')
  })
  it('a runtime/push file importing the client core', () => {
    expect(rejected).toContain('src/runtime/push/runtime/bad.ts')
  })
  it("a CLI file importing another module's internals", () => {
    expect(rejected).toContain('src/cli/bad.ts')
  })
  it('an agents runner importing a client side', () => {
    expect(rejected).toContain('src/services/agents/runtime/runners/terminal/bad.ts')
  })
})
