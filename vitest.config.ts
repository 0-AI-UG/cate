import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Two environments: `.test.ts` runs in node, `.test.tsx` in jsdom.
export default defineConfig({
  plugins: [react(), {
    // Vitest 5 misses node:sqlite in Node 22's builtinModules list.
    name: 'externalize-node-sqlite',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'node:sqlite') return { id, external: true }
    },
  }],
  resolve: {
    alias: {
      'monaco-editor': path.resolve(__dirname, 'node_modules/monaco-editor/esm/vs/editor/editor.api.js'),
      '@kernel': path.resolve(__dirname, 'src/kernel'),
      '@runtime': path.resolve(__dirname, 'src/runtime'),
      '@workspace': path.resolve(__dirname, 'src/workspace'),
      '@services': path.resolve(__dirname, 'src/services'),
      '@client': path.resolve(__dirname, 'src/client'),
      '@panels': path.resolve(__dirname, 'src/panels'),
      '@shells': path.resolve(__dirname, 'src/shells'),
      // The real electron-log BLOCKS at module eval under vitest (it wires up
      // Electron IPC that never resolves), so any test whose import graph reaches
      // the logger would hang the worker — and CI. Route both entry points to an
      // inert stub. Production builds use electron-vite's config, not this one.
      'electron-log/renderer': path.resolve(__dirname, 'src/test/electronLogStub.ts'),
      'electron-log/main': path.resolve(__dirname, 'src/test/electronLogStub.ts'),
      'electron-log': path.resolve(__dirname, 'src/test/electronLogStub.ts'),
    },
  },
  test: {
    restoreMocks: true,
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'] } },
      { extends: true, test: { name: 'renderer', environment: 'jsdom', include: ['src/**/*.test.tsx'] } },
    ],
    setupFiles: ['src/test/setup.ts'],
  },
})
