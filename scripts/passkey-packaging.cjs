const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

function profileEntitlements(data) {
  const entitlements = data.Entitlements ?? {}
  const key = 'com.apple.developer.web-browser.public-key-credential'
  const team = data.TeamIdentifier?.[0]
  const appId = `${team}.com.cate.app`
  const expiration = new Date(data.ExpirationDate).getTime()
  if (entitlements[key] !== true || entitlements['com.apple.application-identifier'] !== appId
    || !team || expiration <= Date.now() || !Number.isFinite(expiration)) {
    throw new Error('Passkey profile must be unexpired, authorize com.cate.app, and contain Apple’s browser passkey entitlement')
  }
  return { [key]: true, 'com.apple.application-identifier': appId, 'com.apple.developer.team-identifier': team }
}

// electron-builder hook: the managed entitlement is included only when an
// Apple-issued profile is supplied. Ordinary builds remain launchable without it.
module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const { buildPasskeys } = await import('./build-passkeys.mjs')
  buildPasskeys()
  let profile = process.env.CATE_PASSKEYS_PROFILE
  const encoded = process.env.CATE_PASSKEYS_PROFILE_BASE64
  if (!profile && !encoded) return
  const directory = mkdtempSync(path.join(tmpdir(), 'cate-passkey-signing-'))
  if (encoded) {
    profile = path.join(directory, 'browser.provisionprofile')
    writeFileSync(profile, Buffer.from(encoded, 'base64'), { mode: 0o600 })
  }
  profile = path.resolve(profile)
  const xml = execFileSync('/usr/bin/security', ['cms', '-D', '-i', profile])
  const data = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }))
  const entitlements = profileEntitlements(data)
  const base = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(__dirname, '../build/entitlements.mac.plist')], { encoding: 'utf8' }))
  Object.assign(base, entitlements)
  const output = path.join(directory, 'entitlements.plist')
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', output, '-'], { input: JSON.stringify(base) })
  const mac = context.packager.config.mac
  mac.entitlements = output
  mac.provisioningProfile = profile
  context.packager.config.forceCodeSigning = true
}
module.exports.profileEntitlements = profileEntitlements
