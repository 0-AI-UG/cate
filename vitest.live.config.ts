import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Live integration config — runs the opt-in *.itest.ts harnesses (real network /
// real server). Separate from vitest.config.ts so the normal suite never picks
// them up. Reuses the electron-log stub so the import graph doesn't hang.
export default defineConfig({
  plugins: [{
    // Match vitest.config.ts: Node 22 omits node:sqlite from builtinModules.
    name: 'externalize-node-sqlite',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'node:sqlite') return { id, external: true }
    },
  }],
  resolve: {
    alias: {
      '@kernel': path.resolve(__dirname, 'src/kernel'),
      '@runtime': path.resolve(__dirname, 'src/runtime'),
      '@workspace': path.resolve(__dirname, 'src/workspace'),
      '@services': path.resolve(__dirname, 'src/services'),
      '@client': path.resolve(__dirname, 'src/client'),
      '@panels': path.resolve(__dirname, 'src/panels'),
      '@shells': path.resolve(__dirname, 'src/shells'),
      'electron-log/renderer': path.resolve(__dirname, 'src/test/electronLogStub.ts'),
      'electron-log/main': path.resolve(__dirname, 'src/test/electronLogStub.ts'),
      'electron-log': path.resolve(__dirname, 'src/test/electronLogStub.ts'),
    },
  },
  test: {
    include: ['src/**/*.itest.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
