import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const args = process.argv.slice(2)
const node = process.execPath
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!process.env.SENTRY_DSN) {
  process.env.SENTRY_DSN = 'https://any@analytics.cero-ai.com/1'
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      env: process.env,
      ...options,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          signal
            ? `${command} exited from signal ${signal}`
            : `${command} exited with code ${code}`,
        ),
      )
    })
  })
}

// Ship the host-target runtime tarball into the installer under the fixed name
// shippedRuntimeTarball() resolves at runtime: runtime-host-<arch>.tgz on macOS
// (the daemon is arch-specific and one .app runs on either CPU), runtime-host.tgz
// elsewhere. electron-builder can't compute the per-target name
// (cate-runtime-<version>-<target>.tgz), and its extraResources glob
// (runtime-host*.tgz) copies whatever is staged — so clear stale staged names
// first to avoid shipping an outdated tarball.
function plat(p) {
  return p === 'win32' ? 'win32' : p // darwin | linux pass through
}
function stageHostRuntimeTarball() {
  const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version
  const target = `${plat(process.platform)}-${process.arch}`
  const distRuntime = path.join(repoRoot, 'dist-runtime')
  const src = path.join(distRuntime, `cate-runtime-${version}-${target}.tgz`)
  const destName =
    process.platform === 'darwin' ? `runtime-host-${process.arch}.tgz` : 'runtime-host.tgz'
  const dest = path.join(distRuntime, destName)
  if (!existsSync(src)) {
    throw new Error(
      `[package] host runtime tarball missing: ${src}\n` +
        'Packaging a local-daemon app requires it — run `npm run runtime:tarball` first.',
    )
  }
  for (const stale of readdirSync(distRuntime)) {
    if (stale.startsWith('runtime-host') && stale.endsWith('.tgz')) {
      rmSync(path.join(distRuntime, stale))
    }
  }
  copyFileSync(src, dest)
  console.log(`[package] staged ${path.relative(repoRoot, src)} → ${path.relative(repoRoot, dest)}`)
}

await run(node, ['scripts/generate-icons.js'])
await run(node, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
stageHostRuntimeTarball()
await run(node, ['node_modules/electron-builder/out/cli/cli.js', ...args])
