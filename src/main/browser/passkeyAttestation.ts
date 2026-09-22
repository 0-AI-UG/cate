import { createPublicKey } from 'node:crypto'

// WebAuthn attestation uses CTAP2's definite-length CBOR subset. This decoder is
// deliberately bounded and only reads data returned by the OS authenticator.
function readCbor(data: Buffer, start = 0): { value: any; end: number } {
  let cursor = start
  const take = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || cursor + length > data.length) throw new Error('Truncated attestation')
    const bytes = data.subarray(cursor, cursor + length)
    cursor += length
    return bytes
  }
  const read = (depth: number): any => {
    if (depth > 16) throw new Error('Attestation nesting limit')
    const header = take(1)[0]
    const major = header >> 5
    const info = header & 31
    if (major === 7 && info >= 20 && info <= 22) return [false, true, null][info - 20]
    let length = info
    if (info === 24) length = take(1).readUInt8()
    else if (info === 25) length = take(2).readUInt16BE()
    else if (info === 26) length = take(4).readUInt32BE()
    else if (info >= 27) throw new Error('Unsupported attestation CBOR')
    if (major === 0) return length
    if (major === 1) return -1 - length
    if (major === 2) return take(length)
    if (major === 3) return take(length).toString('utf8')
    if (length > data.length) throw new Error('Invalid attestation length')
    if (major === 4) return Array.from({ length }, () => read(depth + 1))
    if (major === 5) {
      const result = new Map()
      for (let i = 0; i < length; i++) result.set(read(depth + 1), read(depth + 1))
      return result
    }
    throw new Error('Unsupported attestation CBOR')
  }
  return { value: read(0), end: cursor }
}

export function passkeyAttestationFields(attestation: string) {
  const object = readCbor(Buffer.from(attestation, 'base64url')).value
  const authData = object instanceof Map ? object.get('authData') : null
  if (!Buffer.isBuffer(authData) || authData.length < 55 || !(authData[32] & 0x40)) throw new Error('Invalid attestation data')
  const offset = 55 + authData.readUInt16BE(53)
  const cose = readCbor(authData, offset).value
  if (!(cose instanceof Map) || !Number.isInteger(cose.get(3))) throw new Error('Invalid credential public key')
  let jwk: Record<string, string> | undefined
  const coordinate = (key: number) => {
    const value = cose.get(key)
    if (!Buffer.isBuffer(value)) throw new Error('Invalid key coordinate')
    return value.toString('base64url')
  }
  if (cose.get(1) === 2 && [1, 2, 3].includes(cose.get(-1))) {
    jwk = { kty: 'EC', crv: ({ 1: 'P-256', 2: 'P-384', 3: 'P-521' } as Record<number, string>)[cose.get(-1)], x: coordinate(-2), y: coordinate(-3) }
  } else if (cose.get(1) === 3) {
    jwk = { kty: 'RSA', n: coordinate(-1), e: coordinate(-2) }
  } else if (cose.get(1) === 1 && cose.get(-1) === 6) {
    jwk = { kty: 'OKP', crv: 'Ed25519', x: coordinate(-2) }
  }
  return {
    authenticatorData: authData.toString('base64url'),
    publicKeyAlgorithm: cose.get(3) as number,
    publicKey: jwk ? createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' }).toString('base64url') : null,
  }
}
