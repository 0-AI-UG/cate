import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export function buildPasskeys() {
  if (process.platform !== 'darwin') return
  const require = createRequire(import.meta.url)
  const output = path.join(root, 'dist-native')
  mkdirSync(output, { recursive: true })
  execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=14.4', '-DNAPI_VERSION=8',
    '-I', require('node-api-headers').include_dir,
    '-framework', 'AppKit', '-framework', 'AuthenticationServices', '-framework', 'Security',
    path.join(root, 'native/passkeys/passkeys.mm'), '-o', path.join(output, 'passkeys.node')], { stdio: 'inherit' })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) buildPasskeys()
