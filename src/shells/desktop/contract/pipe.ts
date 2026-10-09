// Byte pipes between desktop main and a renderer: one MessagePort per
// connection. A message is either a chunk of bytes or a control message.
// For a stream pipe a chunk is any slice; for a message pipe (a network
// connection inside the security layer) a chunk is exactly one frame.

export type PipeControl =
  /** The far end is connected (loopback pipes opened by the renderer). */
  | { t: 'open' }
  /** The pipe is closed; `reason` is set when it failed. */
  | { t: 'close'; reason?: string }

export type PipeMessage = Uint8Array | PipeControl

export function isPipeControl(value: unknown): value is PipeControl {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return false
  const t = (value as { t?: unknown }).t
  return t === 'open' || t === 'close'
}

/** Normalizes what a port delivered to bytes, or null when it is not bytes. */
export function pipeBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}
