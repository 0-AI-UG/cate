// `npm run dev`: runs `electron-vite dev`, and when it exits stops the
// workspace runtimes of this checkout's build. Without this a dev runtime
// outlives the session (one with network access on never stops on its own,
// architecture 7.4). Runtimes of other builds (the installed app's) are left
// alone.

import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeBuildId } from './build-id.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The app and the daemon bake the build in at start; a later source edit
// gives runtimes started after it a new one, so check both.
const builds = new Set([computeBuildId(repoRoot)])

const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

// Ctrl-C reaches electron-vite through the process group: wait for it to exit.
process.on('SIGINT', () => {})
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { child.kill(signal) })
}

child.on('exit', (code, signal) => {
  builds.add(computeBuildId(repoRoot))
  stopRuntimes()
  process.exit(code ?? (signal ? 1 : 0))
})

function stopRuntimes() {
  const dir = path.join(os.homedir(), '.cate', 'workspaces')
  let ids = []
  try { ids = readdirSync(dir) } catch { return }
  for (const id of ids) {
    let info
    try { info = JSON.parse(readFileSync(path.join(dir, id, 'runtime.json'), 'utf-8')) } catch { continue }
    if (!builds.has(info.build) || !isRuntime(info.pid)) continue
    // The daemon shuts down cleanly on SIGTERM (hangs up its shells first).
    try {
      process.kill(info.pid, 'SIGTERM')
      console.log(`[dev] stopped runtime of ${info.root} (pid ${info.pid})`)
    } catch {}
  }
}

/** runtime.json outlives the daemon, so its pid may be another process now. */
function isRuntime(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).includes('runtime.cjs')
  } catch {
    return false
  }
}
