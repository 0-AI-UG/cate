// The build of this bundle (scripts/build-id.mjs): the version plus a hash of
// the sources. The daemon sends it in `hello`; a runtime of another build of
// the same protocol connects as `stale` (architecture 7.10). Unset outside a
// bundle (tests).

declare const __CATE_BUILD__: string | undefined

export const RUNTIME_BUILD: string | undefined = typeof __CATE_BUILD__ === 'string' ? __CATE_BUILD__ : undefined

declare const __CATE_RELEASE__: boolean | undefined

/** True only in a bundle the release workflow built (`CATE_RELEASE=1`). A
 *  checkout's bundle never prunes installs: the packaged app on the same
 *  machine may be running from them. */
export const RUNTIME_RELEASE: boolean = typeof __CATE_RELEASE__ === 'boolean' && __CATE_RELEASE__
