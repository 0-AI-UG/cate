import { spawn } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const node = process.execPath

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

await run(node, ['scripts/generate-icons.js'])
await run(node, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
await run(node, ['node_modules/electron-builder/out/cli/cli.js', ...args])
