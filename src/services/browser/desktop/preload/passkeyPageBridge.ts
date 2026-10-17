// Serialized into the page's main world. Keep this function self-contained.
export function installPasskeyPageBridge(): void {
  const bridge = (window as any).__catePasskeys as {
    request(input: unknown): Promise<any>
    cancel(id: string): void
  }
  const credentials = navigator.credentials
  const originalGet = credentials.get.bind(credentials)
  const originalCreate = credentials.create.bind(credentials)
  const encode = (source: BufferSource): string => {
    if (!(source instanceof ArrayBuffer) && !ArrayBuffer.isView(source)) throw new TypeError('Expected a BufferSource')
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    if (bytes.length > 65536) throw new TypeError('Passkey buffer is too large')
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const decode = (text: string): ArrayBuffer => {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer
  }
  const run = async (operation: 'create' | 'get', options: any): Promise<PublicKeyCredential> => {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    if (!isSecureContext || window !== window.top) throw new DOMException('Passkeys require a secure top-level document', 'SecurityError')
    if (options.mediation === 'conditional') throw new DOMException('Conditional passkey UI is unavailable', 'NotSupportedError')
    const key = { ...options.publicKey, challenge: encode(options.publicKey.challenge) }
    if (operation === 'create') key.user = { ...key.user, id: encode(key.user?.id) }
    for (const field of ['allowCredentials', 'excludeCredentials']) {
      if (key[field] !== undefined) key[field] = Array.from(key[field], (c: any) => ({ ...c, id: encode(c.id) }))
    }
    // Extension binary inputs are rejected by main until their native support
    // is implemented; they must never be reported as successfully evaluated.
    const id = crypto.randomUUID()
    let abort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        bridge.cancel(id)
        reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([bridge.request({ id, operation, options: key }), aborted])
      if (result.error) {
        if (result.error === 'TypeError') throw new TypeError('Invalid passkey request')
        throw new DOMException('Passkey request could not be completed', result.error)
      }
      const registration = operation === 'create'
      const data = result.response
      const response = Object.create(registration ? AuthenticatorAttestationResponse.prototype : AuthenticatorAssertionResponse.prototype)
      for (const field of registration ? ['clientDataJSON', 'attestationObject'] : ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle']) {
        Object.defineProperty(response, field, { enumerable: true, value: data[field] === null ? null : decode(data[field]) })
      }
      if (registration) Object.defineProperties(response, {
        getAuthenticatorData: { value: () => decode(data.authenticatorData) },
        getPublicKey: { value: () => data.publicKey ? decode(data.publicKey) : null },
        getPublicKeyAlgorithm: { value: () => data.publicKeyAlgorithm },
        // Do not guess a transport: an empty list leaves discovery unrestricted.
        getTransports: { value: () => [] },
      })
      const json = {
        id: result.id, rawId: result.rawId, type: 'public-key',
        authenticatorAttachment: result.authenticatorAttachment,
        response: registration ? { ...data, transports: [] } : data,
        clientExtensionResults: result.clientExtensionResults ?? {},
      }
      const credential = Object.create(PublicKeyCredential.prototype)
      Object.defineProperties(credential, {
        id: { enumerable: true, value: result.id },
        rawId: { enumerable: true, value: decode(result.rawId) },
        type: { enumerable: true, value: 'public-key' },
        authenticatorAttachment: { enumerable: true, value: result.authenticatorAttachment },
        response: { enumerable: true, value: response },
        getClientExtensionResults: { value: () => structuredClone(json.clientExtensionResults) },
        toJSON: { value: () => structuredClone(json) },
      })
      return credential
    } finally {
      if (abort) options.signal?.removeEventListener('abort', abort)
    }
  }
  Object.defineProperties(credentials, {
    create: { configurable: true, value: (options?: CredentialCreationOptions) => options?.publicKey ? run('create', options) : originalCreate(options) },
    get: { configurable: true, value: (options?: CredentialRequestOptions) => options?.publicKey ? run('get', options) : originalGet(options) },
  })
  Object.defineProperties(PublicKeyCredential, {
    isUserVerifyingPlatformAuthenticatorAvailable: { configurable: true, value: async () => true },
    isConditionalMediationAvailable: { configurable: true, value: async () => false },
    getClientCapabilities: { configurable: true, value: async () => ({
      conditionalGet: false, conditionalCreate: false, hybridTransport: false,
      passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true,
      relatedOrigins: false, signalAllAcceptedCredentials: false,
      signalCurrentUserDetails: false, signalUnknownCredential: false,
    }) },
  })
}
