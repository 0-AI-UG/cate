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
    // Externalize node_modules EXCEPT pi packages — they are pure ESM and
    // must be bundled inline so the CJS main process can load them.
    plugins: [externalizeDepsPlugin({ exclude: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent'] })],
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
    plugins: [externalizeDepsPlugin({ exclude: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent'] })],
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
    // Don't let the dev server watch .cate/ — it holds Cate's own project state
    // and, now, git worktrees (full repo checkouts under .cate/worktrees). When
    // developing Cate-on-Cate, creating a worktree there would otherwise drop a
    // duplicate index.html/tsconfig.json into the watched tree and force a full
    // HMR reload. (Merged with Vite's built-in .git/node_modules ignores.)
    server: {
      watch: {
        ignored: ['**/.cate/**'],
      },
    },
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
