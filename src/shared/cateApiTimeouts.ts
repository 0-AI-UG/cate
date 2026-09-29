/** How long main waits for a renderer to answer a forwarded host API call. */
export const CATE_API_FORWARD_TIMEOUT_MS = 10_000
/** How long a session operation waits for its panel's native surface to mount.
 * Below the forward timeout, so an operation never acts after its caller gave up. */
export const PANEL_SURFACE_WAIT_MS = CATE_API_FORWARD_TIMEOUT_MS - 2_000
