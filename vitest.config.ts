import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { builtinModules } from 'node:module'

// Two-environment setup:
//   - .test.ts  → node env, used by pure-function tests in src/main + src/renderer/drag
//   - .test.tsx → jsdom env, used by the drag integration harness (renders a real
//                 React tree and simulates real mouse events through useDragOp).
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Node 22 omits node:sqlite from builtinModules; jsdom tests still run in Node.
    builtins: [...builtinModules, /^node:/],
    alias: {
      'monaco-editor': path.resolve(__dirname, 'node_modules/monaco-editor/esm/vs/editor/editor.api.js'),
      '@shared': path.resolve(__dirname, 'src/shared'),
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
    setupFiles: ['src/renderer/drag/__tests__/setup.ts'],
  },
})
