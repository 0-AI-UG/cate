import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Bake the Sentry DSN at build time from the SENTRY_DSN env var. End users
// of a packaged build don't have that env var, so the value must be inlined.
// At runtime, process.env.SENTRY_DSN still wins if set (used by dev:sentry).
const sentryDefine = {
  __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN ?? ''),
}

export default defineConfig({
  main: {
    define: sentryDefine,
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    define: sentryDefine,
    build: {
      outDir: 'dist/renderer',
      // Emit source maps in production so crash-report stacks point at real
      // source locations instead of opaque bundled offsets like
      // "index-DULzyrhX.js:33061:54".
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    },
    plugins: [react()],
    css: {
      postcss: './postcss.config.js'
    }
  }
})
