import { expect, type Page } from '@playwright/test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeHome, seedOnCanvas, type LaunchResult } from './electron-app'
import { launchWithRuntime } from './runtime-install'

/** Real files for ripgrep, written into `root`. */
export function writeSearchProject(root: string): void {
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
}

export interface SearchApp extends LaunchResult {
  root: string
  /** The editor whose sidebar shows the search. */
  editor: { panelId: string; nodeId: string }
}

/** Launches with the fixture project and an editor on `src/main/search.ts`. */
export async function launchSearchApp(): Promise<SearchApp> {
  const home = makeHome()
  mkdirSync(path.join(home, 'proj'))
  const root = realpathSync(path.join(home, 'proj'))
  writeSearchProject(root)
  // Content search needs ripgrep beside the daemon's Node.
  const app = await launchWithRuntime({ home, workspace: root })
  const editor = await seedOnCanvas(app.mainWindow, 'editor', { x: 40, y: 40 }, { filePath: path.join(root, 'src/main/search.ts') })
  return { ...app, root, editor }
}

/** Opens the editor's search sidebar and returns the query input. */
export async function openSearch(app: SearchApp) {
  const page = app.mainWindow
  const node = page.locator(`[data-node-id="${app.editor.nodeId}"]`)
  const overlay = node.locator('[data-unfocused-overlay]')
  if (await overlay.count()) await overlay.click()
  await node.getByRole('button', { name: 'Search sidebar' }).click()
  const input = node.locator('input[aria-label="Search"]')
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  return input
}

export interface SearchSnapshot {
  status: 'idle' | 'searching' | 'done' | 'error'
  error: string | null
  totalMatches: number
  fileCount: number
  filePaths: string[]
  lines: number
  matchCase: boolean
  wholeWord: boolean
  isRegex: boolean
  respectIgnore: boolean | null
}

/** What the search view shows, read from its DOM. */
export function searchSnapshot(page: Page, nodeId: string): Promise<SearchSnapshot> {
  return page.evaluate((id) => {
    const root = document.querySelector(`[data-node-id="${id}"]`)!
    const pressed = (label: string) => root.querySelector(`button[aria-label="${label}"]`)?.getAttribute('aria-pressed') === 'true'
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Search"]')
    const statusEl = root.querySelector('.text-red-400') ?? [...root.querySelectorAll('span')].find((s) => /^(No results|Searching|\d+ results? in \d+ files?)/.test(s.textContent ?? ''))
    const text = statusEl?.textContent ?? ''
    const error = root.querySelector('.text-red-400')?.textContent ?? null
    const counts = /^(\d+) results? in (\d+) files?/.exec(text)
    const ignore = [...root.querySelectorAll('label')].find((l) => /Use ignore files/.test(l.textContent ?? ''))?.querySelector('input')
    return {
      status: !input?.value ? 'idle' : error ? 'error' : text.startsWith('Searching') ? 'searching' : text ? 'done' : 'searching',
      error,
      totalMatches: counts ? Number(counts[1]) : 0,
      fileCount: counts ? Number(counts[2]) : 0,
      filePaths: [...root.querySelectorAll('[data-testid="search-file"]')].map((el) => el.getAttribute('data-path') ?? ''),
      lines: root.querySelectorAll('[data-testid="search-line"]').length,
      matchCase: pressed('Match Case'),
      wholeWord: pressed('Match Whole Word'),
      isRegex: pressed('Use Regular Expression'),
      respectIgnore: ignore ? ignore.checked : null,
    } as const
  }, nodeId) as Promise<SearchSnapshot>
}

/** Waits until the search settled and shows the same result twice in a row. */
export async function settle(page: Page, nodeId: string): Promise<SearchSnapshot> {
  let last = ''
  let snap: SearchSnapshot | null = null
  await page.waitForTimeout(250)
  await expect.poll(async () => {
    snap = await searchSnapshot(page, nodeId)
    const key = JSON.stringify(snap)
    const stable = snap.status !== 'searching' && key === last
    last = key
    return stable
  }, { timeout: 30_000, intervals: [200] }).toBe(true)
  return snap!
}
