// Single source of the renderer's macOS check. Main-process code should use
// `process.platform === 'darwin'` instead — this relies on the renderer's
// navigator and isn't available there.
//
// Dev preview override: when the main process is launched with
// `CATE_FAKE_PLATFORM=win32|linux|darwin`, it forwards the value as a
// `?platform=` query param on the renderer URL. That lets you preview the
// Windows/Linux chrome (custom TitlebarStrip + WindowControls) from a Mac
// without a VM. Falls back to the real navigator when unset.
function resolveIsMac(): boolean {
  try {
    const fake = new URLSearchParams(location.search).get('platform')
    if (fake) return fake === 'darwin'
  } catch { /* no location (tests) — fall through */ }
  return navigator.userAgent.includes('Mac')
}

export const IS_MAC = resolveIsMac()
