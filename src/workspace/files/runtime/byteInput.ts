// Pull-style reading of the bytes a client writes to a stream. Uploads send a
// manifest of sizes first, so the runtime knows where each file ends and when
// the upload is complete.

export class ByteInput {
  private chunks: Uint8Array[] = []
  private waiter: (() => void) | null = null
  private closed: Error | null = null

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.wake()
  }

  /** Fails pending and later reads (the stream stopped). */
  close(err: Error): void {
    this.closed = err
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  private async nextChunk(): Promise<Uint8Array> {
    while (this.chunks.length === 0) {
      if (this.closed) throw this.closed
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
    return this.chunks.shift()!
  }

  /** Yields exactly `size` bytes, in the chunks they arrived in (split at the
   *  boundary). */
  async *take(size: number): AsyncGenerator<Uint8Array> {
    let left = size
    while (left > 0) {
      const chunk = await this.nextChunk()
      if (chunk.length > left) {
        this.chunks.unshift(chunk.subarray(left))
        yield chunk.subarray(0, left)
        return
      }
      left -= chunk.length
      yield chunk
    }
  }

  async readAll(size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size)
    let offset = 0
    for await (const chunk of this.take(size)) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  async skip(size: number): Promise<void> {
    for await (const _chunk of this.take(size)) { /* drain */ }
  }

  /** True when bytes beyond the declared sizes arrived. */
  get overflow(): boolean {
    return this.chunks.length > 0
  }
}
