// The build of this bundle (scripts/build-id.mjs): the version plus a hash of
// the sources. The daemon sends it in `hello`; a client refuses a runtime of
// another build. Unset outside a bundle (tests).

declare const __CATE_BUILD__: string | undefined

export const RUNTIME_BUILD: string | undefined = typeof __CATE_BUILD__ === 'string' ? __CATE_BUILD__ : undefined
