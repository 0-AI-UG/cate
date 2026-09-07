// =============================================================================
// FrameDecoder — pure streaming decoder for the cate-nativehost socket
// protocol. See native/nativehost/PROTOCOL.md for the authoritative wire
// format:
//
//   [UInt32 BE payloadLength][UInt8 type][payload: payloadLength bytes]
//
// type 0x01 = JSON control message, 0x02 = raw JPEG frame. No message-count
// prefix, no trailer — keep reading 4 + 1 + payloadLength bytes per message
// until EOF. Unknown types are forwarded as-is (forward-compatible callers
// decide whether to ignore them).
//
// This module has no I/O of its own — NativeAppBroker owns the socket and
// feeds it raw chunks via push(). Kept pure so it's cheap to unit test with
// arbitrary chunk boundaries (split messages, coalesced messages, large
// multi-chunk frames).
// =============================================================================

export interface DecodedMessage {
  type: number
  payload: Buffer
}

const HEADER_LENGTH = 5 // 4-byte BE length + 1-byte type

/** Inbound (main → sidecar) message types. See PROTOCOL.md. */
export const CLIENT_MSG_INPUT = 0x10
export const CLIENT_MSG_RESIZE = 0x11

/** Encode one message in the wire framing: [UInt32 BE len][UInt8 type][payload].
 *  Used by the broker to send input/resize commands to the sidecar. */
export function encodeFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH)
  header.writeUInt32BE(payload.length, 0)
  header.writeUInt8(type, 4)
  return Buffer.concat([header, payload])
}

/** Encode a JSON control message (input/resize) for the sidecar. */
export function encodeJSONFrame(type: number, obj: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(obj), 'utf8'))
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /** Feed the next chunk of bytes read off the socket. Returns every message
   *  fully completed by this call (zero, one, or many), in wire order. Bytes
   *  belonging to a still-incomplete message are retained internally and
   *  prefixed to the next push(). */
  push(chunk: Buffer): DecodedMessage[] {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk

    const messages: DecodedMessage[] = []
    while (this.buffer.length >= HEADER_LENGTH) {
      const payloadLength = this.buffer.readUInt32BE(0)
      const totalLength = HEADER_LENGTH + payloadLength
      if (this.buffer.length < totalLength) break // wait for more data

      const type = this.buffer.readUInt8(4)
      // Copy the payload out — subarray() would otherwise keep the whole
      // concatenated backing buffer alive for as long as any one frame's
      // payload is referenced downstream.
      const payload = Buffer.from(this.buffer.subarray(HEADER_LENGTH, totalLength))
      messages.push({ type, payload })

      this.buffer = this.buffer.subarray(totalLength)
    }
    // Detach the retained remainder from the (possibly large) source buffer
    // it was sliced from, for the same reason as above.
    if (this.buffer.length > 0) this.buffer = Buffer.from(this.buffer)

    return messages
  }
}
