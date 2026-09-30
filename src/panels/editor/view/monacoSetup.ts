// Monaco for the editor view: bundled workers, the Cate theme built from the
// active unified theme, and language detection. Workers are assigned once at
// module load; Monaco caches them per label across every editor.

import * as monaco from 'monaco-editor'
import type { Theme } from '@kernel/ui/contract'

let shuttingDown = false
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { shuttingDown = true }, { once: true })
}

function worker(url: URL, label: string): Worker {
  return new Worker(url, { type: 'module', name: `monaco-${label || 'worker'}` })
}

function createWorker(label: string): Worker {
  const name = label.toLowerCase()
  if (shuttingDown) return worker(new URL('./workers/noop.worker.ts', import.meta.url), name || 'noop')
  if (name === 'json' || name === 'jsonc') return worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), name)
  if (name === 'css' || name === 'scss' || name === 'less') return worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), name)
  if (name === 'html' || name === 'handlebars' || name === 'razor') return worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), name)
  if (['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(name)) {
    return worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), name)
  }
  return worker(new URL('./workers/editorService.worker.ts', import.meta.url), name)
}

const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment?: Record<string, unknown> & { getWorker?: (moduleId: string, label: string) => Worker }
}
monacoGlobal.MonacoEnvironment = {
  ...(monacoGlobal.MonacoEnvironment ?? {}),
  getWorker: (_moduleId: string, label: string) => createWorker(label),
}

export const CATE_MONACO_THEME = 'cate-active'

/** (Re)defines the one Cate theme; every editor using it re-themes. */
export function applyMonacoTheme(theme: Theme): void {
  monaco.editor.defineTheme(CATE_MONACO_THEME, {
    base: theme.editor.base,
    inherit: true,
    rules: theme.editor.tokens.map((token) => ({
      token: token.token,
      ...(token.foreground ? { foreground: token.foreground } : {}),
      ...(token.background ? { background: token.background } : {}),
      ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
    })),
    colors: theme.editor.colors ?? {},
  })
  monaco.editor.setTheme(CATE_MONACO_THEME)
}

const FALLBACK_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', json: 'json',
  md: 'markdown', py: 'python', rs: 'rust', go: 'go', rb: 'ruby', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sh: 'shell', bash: 'shell', zsh: 'shell', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
  xml: 'xml', svg: 'xml', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin',
  sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile', makefile: 'makefile',
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext || ext === filePath.toLowerCase()) return 'plaintext'
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.some((e) => e === `.${ext}` || e === ext)) return language.id
  }
  return FALLBACK_LANGUAGES[ext] ?? 'plaintext'
}

export { monaco }
