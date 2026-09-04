import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLinuxNodePty } from './linux-node-pty.mjs'

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The Linux node-pty baseline regression test must run on a linux-x64 CI runner')
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodePtyVersion = JSON.parse(
  readFileSync(path.join(repoRoot, 'node_modules', 'node-pty', 'package.json'), 'utf-8'),
).version
const outDir = mkdtempSync(path.join(os.tmpdir(), 'cate-linux-node-pty-test-'))

try {
  buildLinuxNodePty({ targetArch: 'x64', nodePtyVersion, outDir })
  console.log(`[runtime] linux-x64 node-pty ${nodePtyVersion} passed the glibc compatibility regression test`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
