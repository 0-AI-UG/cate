// =============================================================================
// PiRpcClient — drives a pi `--mode rpc` process over a Companion's agent
// channel (local in-process or remote over the daemon). It speaks pi's stdio
// JSONL protocol — requests carry an id, `{type:"response",id,success,data|error}`
// frames are correlated responses, everything else is an event — but the
// transport is `companion.agent` instead of a child process pi-coding-agent
// owns. This is a standalone reimplementation so the desktop app no longer
// imports (or bundles) pi: pi ships only as the on-demand tarball the companion
// installs on the host.
// =============================================================================

import type { Companion } from '../../main/companion/types'

export interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
}

interface PiResponse {
  type: 'response'
  id: string
  success: boolean
  data?: unknown
  error?: string
}

type PiEventListener = (event: unknown) => void

export interface PiRpcClientOptions {
  cwd: string
  env?: Record<string, string>
  provider?: string
  model?: string
  args?: string[]
}

let seq = 0

export class PiRpcClient {
  private readonly aid: string
  private readonly pending = new Map<string, { resolve: (r: PiResponse) => void; reject: (e: Error) => void }>()
  private readonly listeners: PiEventListener[] = []
  private readonly exitListeners: Array<(code: number, stderr?: string) => void> = []
  private reqId = 0
  private started = false
  /** Set by stop()/dispose so an expected exit isn't reported as a crash. */
  private disposing = false
  private stderr = ''

  constructor(
    private readonly companion: Companion,
    private readonly options: PiRpcClientOptions,
  ) {
    this.aid = `pi-${++seq}-${companion.id}`
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('PiRpcClient already started')
    this.started = true
    await this.companion.agent.start(
      {
        id: this.aid,
        cwd: this.options.cwd,
        env: this.options.env,
        provider: this.options.provider,
        model: this.options.model,
        args: this.options.args,
      },
      (_id, line) => this.handleLine(line),
      (_id, code, stderr) => {
        if (stderr) this.stderr = stderr
        const detail = stderr ? `:\n${stderr}` : ''
        this.rejectAllPending(`pi process exited (code ${code})${detail}`)
        this.started = false
        if (!this.disposing) {
          for (const l of this.exitListeners) { try { l(code, stderr) } catch { /* noop */ } }
        }
      },
    )
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.disposing = true
    this.companion.agent.stop(this.aid)
    this.rejectAllPending('pi session stopped')
    this.started = false
  }

  onEvent(listener: PiEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i !== -1) this.listeners.splice(i, 1)
    }
  }

  /** Notified when pi exits UNEXPECTEDLY (not via stop()), with its exit code and
   *  recent stderr — so the agent layer can show the user why the agent died. */
  onExit(listener: (code: number, stderr?: string) => void): () => void {
    this.exitListeners.push(listener)
    return () => {
      const i = this.exitListeners.indexOf(listener)
      if (i !== -1) this.exitListeners.splice(i, 1)
    }
  }

  getStderr(): string {
    return this.stderr
  }

  /** Reject every in-flight request (session disposed / pi exited). */
  rejectAllPending(reason = 'pi session disposed'): void {
    const err = new Error(reason)
    for (const { reject } of this.pending.values()) {
      try { reject(err) } catch { /* noop */ }
    }
    this.pending.clear()
  }

  /** Write a raw object to pi's stdin (extension UI sub-protocol). */
  writeRaw(obj: unknown): void {
    this.companion.agent.writeLine(this.aid, JSON.stringify(obj))
  }

  // ---- Command methods (1:1 with pi's RpcClient) --------------------------

  async prompt(message: string, images?: PiImageContent[]): Promise<void> { await this.send({ type: 'prompt', message, images }) }
  async steer(message: string, images?: PiImageContent[]): Promise<void> { await this.send({ type: 'steer', message, images }) }
  async followUp(message: string, images?: PiImageContent[]): Promise<void> { await this.send({ type: 'follow_up', message, images }) }
  async abort(): Promise<void> { await this.send({ type: 'abort' }) }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.data(await this.send({ type: 'new_session', parentSession }))
  }
  async getState(): Promise<unknown> { return this.data(await this.send({ type: 'get_state' })) }
  async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    return this.data(await this.send({ type: 'set_model', provider, modelId }))
  }
  async setThinkingLevel(level: string): Promise<void> { await this.send({ type: 'set_thinking_level', level }) }
  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> { await this.send({ type: 'set_steering_mode', mode }) }
  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> { await this.send({ type: 'set_follow_up_mode', mode }) }
  async compact(customInstructions?: string): Promise<unknown> { return this.data(await this.send({ type: 'compact', customInstructions })) }
  async setAutoCompaction(enabled: boolean): Promise<void> { await this.send({ type: 'set_auto_compaction', enabled }) }
  async setAutoRetry(enabled: boolean): Promise<void> { await this.send({ type: 'set_auto_retry', enabled }) }
  async abortRetry(): Promise<void> { await this.send({ type: 'abort_retry' }) }
  async bash(command: string): Promise<unknown> { return this.data(await this.send({ type: 'bash', command })) }
  async abortBash(): Promise<void> { await this.send({ type: 'abort_bash' }) }
  async getSessionStats(): Promise<unknown> { return this.data(await this.send({ type: 'get_session_stats' })) }
  async exportHtml(outputPath?: string): Promise<{ path: string }> { return this.data(await this.send({ type: 'export_html', outputPath })) }
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> { return this.data(await this.send({ type: 'switch_session', sessionPath })) }
  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> { return this.data(await this.send({ type: 'fork', entryId })) }
  async clone(): Promise<{ cancelled: boolean }> { return this.data(await this.send({ type: 'clone' })) }
  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    return this.data<{ messages: Array<{ entryId: string; text: string }> }>(await this.send({ type: 'get_fork_messages' })).messages
  }
  async getLastAssistantText(): Promise<string | null> {
    return this.data<{ text: string | null }>(await this.send({ type: 'get_last_assistant_text' })).text
  }
  async setSessionName(name: string): Promise<void> { await this.send({ type: 'set_session_name', name }) }
  async getMessages(): Promise<unknown[]> {
    return this.data<{ messages: unknown[] }>(await this.send({ type: 'get_messages' })).messages
  }
  async getCommands(): Promise<Array<{ name: string; description: string; source: 'extension' | 'prompt' | 'skill'; sourceInfo?: { path?: string; scope?: 'user' | 'project' | 'temporary' } }>> {
    return this.data<{ commands: Array<{ name: string; description: string; source: 'extension' | 'prompt' | 'skill'; sourceInfo?: { path?: string; scope?: 'user' | 'project' | 'temporary' } }> }>(
      await this.send({ type: 'get_commands' }),
    ).commands
  }

  // ---- Internal -----------------------------------------------------------

  private handleLine(line: string): void {
    let data: unknown
    try { data = JSON.parse(line) } catch { return }
    const frame = data as PiResponse
    if (frame && frame.type === 'response' && frame.id && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!
      this.pending.delete(frame.id)
      p.resolve(frame)
      return
    }
    for (const listener of this.listeners) {
      try { listener(data) } catch { /* a bad listener must not break the pipe */ }
    }
  }

  private send(command: Record<string, unknown>): Promise<PiResponse> {
    if (!this.started) return Promise.reject(new Error('PiRpcClient not started'))
    const id = `req_${++this.reqId}`
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timeout waiting for response to ${String(command.type)}`))
      }, 30000)
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.companion.agent.writeLine(this.aid, JSON.stringify({ ...command, id }))
    })
  }

  private data<T = unknown>(response: PiResponse): T {
    if (!response.success) throw new Error(response.error ?? 'pi rpc error')
    return response.data as T
  }
}
