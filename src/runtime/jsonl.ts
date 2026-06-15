// =============================================================================
// LF-delimited JSON framing. One JSON object per line; '\n' terminates a frame.
// A trailing '\r' is tolerated (WSL / Windows pipes), so the decoder is safe
// over wsl.exe stdio. Mirrors the pi RpcClient framing; copied here so the
// runtime bundle has no dependency on pi.
// =============================================================================

import type { AnyFrame } from './protocol'

/** Serialize one frame to a single newline-terminated line. */
export function serializeFrame(frame: AnyFrame): string {
  // JSON.stringify never emits a raw newline, so one frame == one line.
  return JSON.stringify(frame) + '\n'
}

/**
 * Incremental line decoder. Feed it arbitrary chunks (string or Buffer); it
 * invokes `onFrame` once per complete line, ignoring blank lines and reporting
 * malformed JSON via `onError` instead of throwing (a single bad line must not
 * tear down the whole connection).
 */
export class FrameDecoder {
  private buffer = ''

  constructor(
    private readonly onFrame: (frame: AnyFrame) => void,
    private readonly onError?: (line: string, err: unknown) => void,
  ) {}

  push(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      let line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) {
        try {
          this.onFrame(JSON.parse(line) as AnyFrame)
        } catch (err) {
          this.onError?.(line, err)
        }
      }
      nl = this.buffer.indexOf('\n')
    }
  }

  /** Bytes buffered but not yet terminated by a newline (for diagnostics). */
  get pending(): number {
    return this.buffer.length
  }
}
