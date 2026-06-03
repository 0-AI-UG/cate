import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
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

// Ship the host-target companion tarball into the installer under a fixed name.
// electron-builder can't compute the per-target name (cate-companion-<version>-<target>.tgz),
// so copy it to dist-companion/companion-host.tgz (extraResources → resources/companion-host.tgz).
function plat(p) {
  return p === 'win32' ? 'win32' : p // darwin | linux pass through
}
function stageHostCompanionTarball() {
  const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version
  const target = `${plat(process.platform)}-${process.arch}`
  const src = path.join(repoRoot, 'dist-companion', `cate-companion-${version}-${target}.tgz`)
  const dest = path.join(repoRoot, 'dist-companion', 'companion-host.tgz')
  if (!existsSync(src)) {
    throw new Error(
      `[package] host companion tarball missing: ${src}\n` +
        'Packaging a local-daemon app requires it — run `npm run companion:tarball` first.',
    )
  }
  copyFileSync(src, dest)
  console.log(`[package] staged ${path.relative(repoRoot, src)} → ${path.relative(repoRoot, dest)}`)
}

await run(node, ['scripts/generate-icons.js'])
await run(node, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
stageHostCompanionTarball()
await run(node, ['node_modules/electron-builder/out/cli/cli.js', ...args])
