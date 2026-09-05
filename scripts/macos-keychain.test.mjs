import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('app-builder-lib')
const { MacPackager } = require('app-builder-lib/out/macPackager.js')

const root = fileURLToPath(new URL('..', import.meta.url))

it('does not ask electron-builder to re-import the macOS certificate', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const macPackage = workflow.match(/- name: Package \(macOS\)([\s\S]*?)(?=\n      - name:)/)[1]
  expect(macPackage).not.toMatch(/\bCSC_LINK:/)
  expect(macPackage).not.toMatch(/\bCSC_KEY_PASSWORD:/)
})

it.skipIf(process.platform === 'win32')('exports the imported keychain and electron-builder uses it without re-importing', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cate-keychain-test-'))
  try {
    // Only the macOS security CLI is simulated; no real certificate or keychain
    // is accessed. Execute the actual setup script and builder selection code.
    const security = path.join(directory, 'security')
    writeFileSync(security, '#!/bin/sh\ncase "$1" in\nfind-identity) echo "1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \\"Developer ID Application: Fixture\\"";;\nesac\n')
    chmodSync(security, 0o755)
    const uuidgen = path.join(directory, 'uuidgen')
    writeFileSync(uuidgen, '#!/bin/sh\necho fixture-keychain-password\n')
    chmodSync(uuidgen, 0o755)
    const envFile = path.join(directory, 'github-env')
    execFileSync('bash', [path.join(root, 'scripts/ci-mac-signing-keychain.sh')], {
      env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, RUNNER_TEMP: directory, GITHUB_ENV: envFile, CSC_LINK: 'Zml4dHVyZQ==', CSC_KEY_PASSWORD: 'fixture-certificate-password' },
    })
    const exported = Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map(line => {
      const index = line.indexOf('=')
      return [line.slice(0, index), line.slice(index + 1)]
    }))
    expect(exported.CSC_KEYCHAIN).toBe(path.join(directory, 'cate-runtime-signing.keychain-db'))
    expect(exported.CATE_MAC_SIGN_IDENTITY).toBe('A'.repeat(40))
    vi.stubEnv('CSC_LINK', undefined)
    vi.stubEnv('CSC_KEYCHAIN', exported.CSC_KEYCHAIN)
    class SigningOnlyPackager extends MacPackager {
      prepareAppInfo() { return {} }
    }
    const packager = new SigningOnlyPackager({ config: { mac: {} } })
    await expect(packager.codeSigningInfo.value).resolves.toEqual({ keychainFile: exported.CSC_KEYCHAIN })
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
})
