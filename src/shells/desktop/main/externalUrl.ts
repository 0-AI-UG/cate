// What the OS may open for Cate: web and mail links only, and never a
// loopback page (D10): that one belongs to the runtime's machine, which may
// not be this one, so it opens in a browser panel through the runtime.

import { isLoopbackUrl } from '@runtime/tunnel/contract'

/** `url` when the OS may open it; throws otherwise. */
export function externalUrl(url: unknown): string {
  if (typeof url !== 'string' || !/^(https?|mailto):/i.test(url)) throw new Error('Only web and mail links open externally.')
  if (isLoopbackUrl(url)) throw new Error('A loopback page opens in Cate, not in the system browser.')
  return url
}
