import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Live integration config — runs the opt-in *.itest.ts harnesses (real network /
// real server). Separate from vitest.config.ts so the normal suite never picks
// them up. Reuses the electron-log stub so the import graph doesn't hang.
export default defineConfig({
  resolve: {
    alias: {
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
