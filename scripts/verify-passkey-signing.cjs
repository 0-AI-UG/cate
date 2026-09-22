const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin'
    || !(process.env.CATE_PASSKEYS_PROFILE || process.env.CATE_PASSKEYS_PROFILE_BASE64)) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(path.join(app, 'Contents/embedded.provisionprofile'))) throw new Error('Signed passkey build is missing its embedded provisioning profile')
  const xml = execFileSync('/usr/bin/codesign', ['--display', '--entitlements', ':-', app], { stdio: ['ignore', 'pipe', 'pipe'] })
  const entitlements = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }))
  if (entitlements['com.apple.developer.web-browser.public-key-credential'] !== true) throw new Error('Signed app is missing the browser passkey entitlement')
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', path.join(app, 'Contents/Resources/passkeys.node')])
}
