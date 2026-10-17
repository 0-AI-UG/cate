import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from './encoding'
import { keyPairFromSecret } from './keys'
import { CipherState, HandshakeState, NoiseError, type HandshakeResult } from './noise'
import { base32Decode, base32Encode } from './encoding'

// Official vectors for Noise_XX_25519_ChaChaPoly_BLAKE2b, copied verbatim from
// cacophony (vectors/cacophony.txt) and snow (tests/vectors/snow.txt).
// Messages alternate initiator, responder, initiator, ... through the
// handshake and on into transport messages.
const VECTORS = [
  {
    source: 'cacophony',
    prologue: '4a6f686e2047616c74',
    initStatic: 'e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1',
    initEphemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
    respStatic: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
    respEphemeral: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
    handshakeHash:
      '8cf47d7b3cb5804c0109d48e8bcdbee2cbb65687d8ea2c92994ca361fb86151ad93627b98936cbb32de56e8abb21def3925011ac3e35db9cbeea73ab9a4392c2',
    messages: [
      ['4c756477696720766f6e204d69736573', 'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573'],
      ['4d757272617920526f746862617264', '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088430505b6745ce64a5f33f0e8e3b83f11ce8802bca507f4f2d8b564dbe277e1966116e132faa2dfd70b8b077b9f94b913df5056ae1319469b824a98d54bbaa82c325595587064f978c4b6d104f7596e6f'],
      ['462e20412e20486179656b', '99579e1c1ee15e422a57ddd6b16d37087b17558e8369c18991b4b2ca3a824abf904cdcf5458b5431a75af034ca9e9b982de039eaaf156775e2d580cd4e5ebae89c3f8cb2594b556d8a8169'],
      ['4361726c204d656e676572', 'fc56eea290b3f3a21aac0c70cd5787b5ee99be37d2f4d751329b55'],
      ['4a65616e2d426170746973746520536179', 'bb31c9da10d5639a4cdb88a12f5c61de41bbc7df09bf75d94f8184fe4157f5c68f'],
      ['457567656e2042f6686d20766f6e2042617765726b', 'f6199cadb152fb27f82be0a0891ec76a33598ae92a46cab2fb5a8ed5bf48b7f267f8370af7'],
    ],
  },
  {
    source: 'snow',
    prologue:
      '5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e',
    initStatic: '842752777821bd4c9a6a84c777cb9028ba2446c864e035c8d380632dca3a7702',
    initEphemeral: '5dfce6be0b767fc60a51e1d627711c67d63e97115cb3957a64a66919747ea47c',
    respStatic: '8885e7006b27a44bec4a6e7bfcc37032a3564a73bf9588585bd1166829d80d8a',
    respEphemeral: '9c012e056ed37994a4bfb09f57a7505bf44c07e9784c3c2bcefd8880b2d85e21',
    handshakeHash: null,
    messages: [
      ['bcb708376354e0dc837fc3f7e0e9c8c59849fd907a129a3c0afde64e79d1ac09', '50a7da541baa50d563e3fd3526f53e9b7e4af8083a4180b5d1f8cd49fbe30518bcb708376354e0dc837fc3f7e0e9c8c59849fd907a129a3c0afde64e79d1ac09'],
      ['77783888d07aa30dfeccf96d8da0a293546232bc8a460b5fbca479e3da54d3b2', '6b0ae570deada82b6f3071c87bd361014c34f8d15fee49ed0078f38a9c05bb703c2eb46ccc2734a9c07555b85d6f0b5ae29f24aaa2c351d815acd2e1de7770344339d0d854daf5a4468b189caf7ff643d6c5645e9e7fd5edcad6755ea0a01f51f552650ab99b7a0eba09f64b9dc0737f5756688682897c0912890a6ec56d72f8'],
      ['420d0154f4e26a4224c201f3ecceddc06eb8896b78386978fb25b21dd276c6fb', '386d9e2549dcb9a016db7e05f45c19d2c4fd4e7a61d1c06dbd01d21012d448b34761826aa7b3fc8d0c5cc73d487c1f19ac29de837b4ccd361603f03d12f8971ae0534fbd8096fd5bc2c7bdc77026207623514afa5804d07a3b0c316f9e5a9c12'],
      ['58f929d4d8eda457fb01b3a09bb6391aac0d93477df9e3042355741747744571', 'c81ba3d22336cd78d64ff9e2161d339db9fd3a5407a3fb594fb7a59d718e83c6054b1002721e63ffb2a2d2d8bfd670bc'],
      ['c86af330a6b59de9d7ead76260204ef7e897a1323bdc0a9c5ea4450556ed0bf6', '1207c87bc8ec9b6d5db3a3d3ed5caab43c98e71492a424b7d7302ea8313d1b0e3644c9b3c479a80cdb3da1e92466b8ac'],
    ],
  },
]

describe('Noise_XX_25519_ChaChaPoly_BLAKE2b', () => {
  for (const vector of VECTORS) {
    it(`reproduces the ${vector.source} test vector`, () => {
      const init = new HandshakeState({
        initiator: true,
        prologue: hexToBytes(vector.prologue),
        staticKeys: keyPairFromSecret(hexToBytes(vector.initStatic)),
        ephemeral: keyPairFromSecret(hexToBytes(vector.initEphemeral)),
      })
      const resp = new HandshakeState({
        initiator: false,
        prologue: hexToBytes(vector.prologue),
        staticKeys: keyPairFromSecret(hexToBytes(vector.respStatic)),
        ephemeral: keyPairFromSecret(hexToBytes(vector.respEphemeral)),
      })
      let initDone: HandshakeResult | null = null
      let respDone: HandshakeResult | null = null
      vector.messages.forEach(([payload, ciphertext], index) => {
        const fromInit = index % 2 === 0
        let wire: Uint8Array
        let read: Uint8Array
        if (!initDone || !respDone) {
          const [writer, reader] = fromInit ? [init, resp] : [resp, init]
          wire = writer.writeMessage(hexToBytes(payload))
          read = reader.readMessage(wire)
          if (init.isComplete() && resp.isComplete()) {
            initDone = init.finish()
            respDone = resp.finish()
          }
        } else {
          const [sender, receiver] = fromInit ? [initDone.send, respDone.receive] : [respDone.send, initDone.receive]
          wire = sender.encryptWithAd(new Uint8Array(0), hexToBytes(payload))
          read = receiver.decryptWithAd(new Uint8Array(0), wire)
        }
        expect(bytesToHex(wire)).toBe(ciphertext)
        expect(bytesToHex(read)).toBe(payload)
      })
      const a = initDone as HandshakeResult | null
      const b = respDone as HandshakeResult | null
      expect(a && b).toBeTruthy()
      expect(bytesToHex(a!.handshakeHash)).toBe(bytesToHex(b!.handshakeHash))
      if (vector.handshakeHash) expect(bytesToHex(a!.handshakeHash)).toBe(vector.handshakeHash)
      expect(bytesToHex(a!.remoteStatic)).toBe(bytesToHex(keyPairFromSecret(hexToBytes(vector.respStatic)).publicKey))
    })
  }

  it('rejects a tampered handshake message', () => {
    const init = new HandshakeState({ initiator: true, staticKeys: keyPairFromSecret(new Uint8Array(32).fill(7)) })
    const resp = new HandshakeState({ initiator: false, staticKeys: keyPairFromSecret(new Uint8Array(32).fill(9)) })
    resp.readMessage(init.writeMessage())
    const second = resp.writeMessage()
    second[40] ^= 1
    expect(() => init.readMessage(second)).toThrow(NoiseError)
  })

  it('keeps the nonce on a failed decrypt', () => {
    const key = new Uint8Array(32).fill(3)
    const send = new CipherState()
    const receive = new CipherState()
    send.initializeKey(key)
    receive.initializeKey(key)
    const first = send.encryptWithAd(new Uint8Array(0), Uint8Array.of(1))
    const bad = first.slice()
    bad[0] ^= 1
    expect(() => receive.decryptWithAd(new Uint8Array(0), bad)).toThrow(NoiseError)
    expect(receive.decryptWithAd(new Uint8Array(0), first)).toEqual(Uint8Array.of(1))
  })
})

describe('base32', () => {
  it('matches RFC 4648 vectors, lowercase and unpadded', () => {
    const cases: Array<[string, string]> = [['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi']]
    for (const [plain, encoded] of cases) {
      expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded)
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain)
    }
  })
})
