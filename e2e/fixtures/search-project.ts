import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Real files for ripgrep, with no developer checkout or saved Cate session. */
export function createSearchProject(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cate-search-e2e-')))
  const files: Record<string, string> = {
    '.ignore': 'ignored/\n',
    'README.md': '# Search fixture\nWe use hooks to exercise literal and whole-word search.\n',
    'src/main/search.ts': [
      '// Search registration entry point.',
      'export function registerSearchHandlers() {',
      '  return "ready"',
      '}',
      '',
      'export const registration = registerSearchHandlers()',
      '',
    ].join('\n'),
    'src/ui/SearchView.tsx': [
      'import { useState, useEffect } from "react"',
      'export function SearchView() {',
      '  const [query] = useState("fixture")',
      '  useEffect(() => {}, [])',
      '  return <main>{query}</main>',
      '}',
      '',
    ].join('\n'),
    'src/ui/nested/HookPanel.tsx': [
      'import { useState } from "react"',
      'export function HookPanel() {',
      '  const [value] = useState("nested")',
      '  return <section>{value}</section>',
      '}',
      '',
    ].join('\n'),
    'src/hooks/useSearch.ts': [
      'import { useState, useEffect } from "react"',
      'export function useSearch() {',
      '  useEffect(() => {}, [])',
      '  return useState(0)',
      '}',
      '',
    ].join('\n'),
    'src/features/search-registration.ts': [
      'import { registerSearchHandlers } from "../main/search"',
      'export const ready = registerSearchHandlers()',
      '',
    ].join('\n'),
    'ignored/generated.ts': '// registerSearchHandlers should only appear when ignore files are disabled.\n',
  }
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return root
}
