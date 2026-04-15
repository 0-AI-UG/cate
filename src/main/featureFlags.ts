import { app } from 'electron'

function devOnlyFlagEnabled(name: string): boolean {
  return !app.isPackaged && process.env[name] === '1'
}

export function disableTrustScoping(): boolean {
  return devOnlyFlagEnabled('CATE_DISABLE_TRUST_SCOPING')
}

export function disableWebviewHardening(): boolean {
  return devOnlyFlagEnabled('CATE_DISABLE_WEBVIEW_HARDENING')
}

export function disableRendererSandbox(): boolean {
  return devOnlyFlagEnabled('CATE_DISABLE_RENDERER_SANDBOX')
}

export function disableVerifiedUpdater(): boolean {
  return devOnlyFlagEnabled('CATE_DISABLE_VERIFIED_UPDATER')
}
