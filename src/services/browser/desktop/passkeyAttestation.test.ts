import { generateKeyPairSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { passkeyAttestationFields } from './passkeyAttestation'

// A small real ES256 attestation fixture: canonical CBOR with an attested key.
function fixture() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const coordinate = (text: string) => Buffer.concat([Buffer.from([0x58, 32]), Buffer.from(text, 'base64url')])
  const cose = Buffer.concat([Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21]), coordinate(jwk.x!), Buffer.from([0x22]), coordinate(jwk.y!)])
  const prefix = Buffer.alloc(56)
  prefix[32] = 0x41
  prefix.writeUInt16BE(1, 53)
  prefix[55] = 1
  const authData = Buffer.concat([prefix, cose])
  const attestation = Buffer.concat([Buffer.from([0xa1, 0x68]), Buffer.from('authData'), Buffer.from([0x58, authData.length]), authData])
  return { attestation, authData, publicKey }
}

it('returns authenticator data, algorithm and standard SPKI public key', () => {
  const { attestation, authData, publicKey } = fixture()
  expect(passkeyAttestationFields(attestation.toString('base64url'))).toEqual({
    authenticatorData: authData.toString('base64url'), publicKeyAlgorithm: -7,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  })
})
it('rejects truncated and malformed attestation', () => {
  const { attestation } = fixture()
  expect(() => passkeyAttestationFields(attestation.subarray(0, -1).toString('base64url'))).toThrow()
  expect(() => passkeyAttestationFields('ow')).toThrow()
})
