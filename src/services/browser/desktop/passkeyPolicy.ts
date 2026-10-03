import { getDomain } from 'tldts'

export function passkeyRelyingParty(origin: string, requested?: unknown): string {
  const url = new URL(origin)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) {
    throw new DOMException('Passkeys require a secure origin', 'SecurityError')
  }
  const rp = requested === undefined ? url.hostname : requested
  if (typeof rp !== 'string' || !rp || rp !== rp.toLowerCase()
    || (rp !== url.hostname && !url.hostname.endsWith(`.${rp}`))
    || (rp !== 'localhost' && !getDomain(rp, { allowPrivateDomains: true }))) {
    throw new DOMException('Invalid relying party for this origin', 'SecurityError')
  }
  return rp
}

export function validatePasskeyRequest(operation: unknown, options: unknown, origin: string): Record<string, any> {
  if ((operation !== 'create' && operation !== 'get') || !options || typeof options !== 'object') {
    throw new TypeError('Invalid passkey request')
  }
  const value = options as Record<string, any>
  const bytes = (input: unknown, max: number) => typeof input === 'string'
    && /^[A-Za-z0-9_-]+$/.test(input) && Buffer.from(input, 'base64url').length <= max
  if (!bytes(value.challenge, 65536)) throw new TypeError('Invalid challenge')
  const rpId = passkeyRelyingParty(origin, operation === 'create' ? value.rp?.id : value.rpId)
  if (operation === 'create') {
    if (typeof value.rp?.name !== 'string' || typeof value.user?.name !== 'string'
      || typeof value.user?.displayName !== 'string' || !bytes(value.user?.id, 64)
      || !Array.isArray(value.pubKeyCredParams) || !value.pubKeyCredParams.length
      || value.pubKeyCredParams.some((p: any) => p?.type !== 'public-key' || !Number.isInteger(p.alg))) {
      throw new TypeError('Invalid registration options')
    }
  }
  for (const field of ['allowCredentials', 'excludeCredentials']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].length > 256
      || value[field].some((c: any) => c?.type !== 'public-key' || !bytes(c.id, 65536)))) {
      throw new TypeError('Invalid credential descriptors')
    }
  }
  const verification = value.userVerification ?? value.authenticatorSelection?.userVerification
  if (verification !== undefined && !['required', 'preferred', 'discouraged'].includes(verification)) {
    throw new TypeError('Invalid user verification preference')
  }
  const attachment = value.authenticatorSelection?.authenticatorAttachment
  if (attachment !== undefined && !['platform', 'cross-platform'].includes(attachment)) throw new TypeError('Invalid authenticator attachment')
  const resident = value.authenticatorSelection?.residentKey
  if (resident !== undefined && !['required', 'preferred', 'discouraged'].includes(resident)) throw new TypeError('Invalid resident key preference')
  if (value.attestation !== undefined && !['none', 'indirect', 'direct', 'enterprise'].includes(value.attestation)) throw new TypeError('Invalid attestation preference')
  // Do not silently ignore extension requirements the native bridge cannot meet.
  if (value.attestation === 'enterprise' || Object.keys(value.extensions ?? {}).some((key) => key !== 'credProps')) {
    throw new DOMException('This passkey extension is not supported', 'NotSupportedError')
  }
  return { ...value, rpId }
}
