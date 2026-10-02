// Entry of the `cate` CLI.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_VERSION, EXIT_ENV, runCli, type CliDeps, type HelpStyle } from './engine'
import { serveCommand, SERVE_SUMMARY } from './serve'
import { connectSocket } from './socketPort'
import { CATE_API } from '@panels/api'

async function writeImage(base64: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'cate-browser-')), 'screenshot.png')
  await writeFile(path, Buffer.from(base64, 'base64'), { mode: 0o600 })
  return path
}

const stdout = (text: string) => { process.stdout.write(`${text}\n`) }
const stderr = (text: string) => { process.stderr.write(`${text}\n`) }

/** Commands that are not API methods. */
const EXTRA_COMMANDS: CliDeps['extraCommands'] = {
  serve: {
    summary: SERVE_SUMMARY,
    run: serveCommand({ cwd: process.cwd(), execPath: process.execPath, platform: process.platform, stdout, stderr }),
  },
}

/** Help fits the terminal (60 to 100 columns) and is bold only on a TTY without NO_COLOR. */
function helpStyle(): HelpStyle {
  const columns = process.stdout.columns ?? 80
  return {
    width: Math.min(Math.max(columns, 60), 100),
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  }
}

/** Runs the CLI. */
export function main(argv: string[], extraCommands: CliDeps['extraCommands'] = EXTRA_COMMANDS): Promise<number> {
  return runCli(argv, CATE_API, {
    env: process.env,
    cwd: process.cwd(),
    stdout,
    stderr,
    connect: (socketPath, token) => connectSocket(socketPath, token, CLI_VERSION),
    writeImage,
    extraCommands,
    style: helpStyle(),
  })
}

if (typeof require !== 'undefined' && require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => {
      process.stderr.write(`cate: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = EXIT_ENV
    },
  )
}
