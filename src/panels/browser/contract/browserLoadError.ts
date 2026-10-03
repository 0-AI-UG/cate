// did-fail-load classification for the view's <webview>.

/** Electron's errorCode for an aborted load (ERR_ABORTED), fired when the
 *  user navigates away mid-load, a redirect supersedes the request, etc. */
const ERR_ABORTED = -3

export interface DidFailLoadEvent {
  errorCode: number
  errorDescription?: string
  isMainFrame?: boolean
}

/** Decide whether a did-fail-load event should surface the page-error overlay.
 *  Only main-frame failures matter: a blocked tracker or dead embed fails in a
 *  subframe while the page itself is fine. Aborted loads (ERR_ABORTED) are not
 *  real failures either. Returns the description to show, or null to ignore. */
export function pageLoadErrorFrom(event: DidFailLoadEvent): string | null {
  if (event.errorCode === ERR_ABORTED) return null
  // isMainFrame is absent on some older event shapes; treat absence as main
  // frame so we don't regress to silently swallowing genuine top-level errors.
  if (event.isMainFrame === false) return null
  return event.errorDescription || 'Failed to load page'
}
