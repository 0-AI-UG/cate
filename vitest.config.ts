import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Two-environment setup:
//   - .test.ts  → node env, used by pure-function tests in src/main + src/renderer/drag
//   - .test.tsx → jsdom env, used by the drag integration harness (renders a real
//                 React tree and simulates real mouse events through useDragOp).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
    environmentMatchGlobs: [
      ['**/*.test.tsx', 'jsdom'],
      ['**/*.test.ts', 'node'],
    ],
    setupFiles: ['src/renderer/drag/__tests__/setup.ts'],
  },
})
