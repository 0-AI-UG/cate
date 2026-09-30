import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Bake the Sentry DSN at build time from the SENTRY_DSN env var. End users
// of a packaged build don't have that env var, so the value must be inlined.
// At runtime, process.env.SENTRY_DSN still wins if set (used by dev:sentry).
// Module aliases shared by every entry (section 17 of docs/architecture.md).
const alias = Object.fromEntries(
  ['kernel', 'runtime', 'workspace', 'services', 'client', 'panels', 'shells']
    .map((name) => [`@${name}`, resolve(__dirname, `src/${name}`)]),
)

const sentryDefine = {
  __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN ?? ''),
}

export default defineConfig({
  main: {
    resolve: { alias },
    define: sentryDefine,
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          // The desktop shell's main (architecture 15).
          shell: resolve(__dirname, 'src/shells/desktop/main/index.ts'),
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          // The desktop shell's preloads. They share no module with any other
          // entry, so rollup emits no shared chunk (the sandboxed preload
          // loader cannot require one): src/shells/desktop/preload/preload.test.ts.
          shell: resolve(__dirname, 'src/shells/desktop/preload/index.ts'),
          shellGuest: resolve(__dirname, 'src/services/browser/desktop/preload/guest.ts'),
          shellCodeCell: resolve(__dirname, 'src/services/browser/desktop/preload/codeCell.ts'),
        }
      }
    }
  },
  renderer: {
    root: '.',
    resolve: { alias },
    define: sentryDefine,
    // Don't let the dev server watch .cate/ — it holds Cate's own project state
    // and, now, git worktrees (full repo checkouts under .cate/worktrees). When
    // developing Cate-on-Cate, creating a worktree there would otherwise drop a
    // duplicate index.html/tsconfig.json into the watched tree and force a full
    // HMR reload. Anchored to `${root}/.cate` rather than a bare `**/.cate/**`:
    // the latter matches against ABSOLUTE paths, so when dev runs FROM INSIDE a
    // worktree (whose own path contains `/.cate/worktrees/…`) it would ignore the
    // worktree's entire source tree and break HMR. (Merged with Vite's built-in
    // .git/node_modules ignores.)
    server: {
      watch: {
        ignored: [`${resolve(__dirname, '.cate')}/**`],
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
