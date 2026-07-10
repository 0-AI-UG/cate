// =============================================================================
// RpcServer — the daemon half. Reads `req` frames off the input pipe, dispatches
// each to the hosted Runtime capability object, and writes a `res` frame back.
// File-watch subscriptions produce `evt` frames keyed by a streamId. Emits the
// `hello` handshake on start.
//
// Capability types are imported type-only from the main process module so the
// runtime bundle carries no runtime dependency on main (the import is erased
// by esbuild). The hosted object is a plain Runtime — the electron-free
// capability set built inside the daemon (see index.ts / buildDaemonRuntime).
// =============================================================================

import { FrameDecoder, serializeFrame } from './jsonl'
import {
  RUNTIME_PROTOCOL_VERSION,
  Methods,
  type ReqFrame,
  type HelloFrame,
  type FsWatchEvtPayload,
  type SearchEvtPayload,
} from './protocol'
import { RUNTIME_VERSION } from './version'
import type { FileAccessContext, Runtime } from '../main/runtime/types'
import type { SearchOptions } from '../shared/types'

export interface RpcServerOptions {
  /** Override hello fields (tests / version-skew simulation). */
  hello?: Partial<Pick<HelloFrame, 'node' | 'os' | 'runtimeVersion' | 'protocolVersion'>>
}

export class RpcServer {
  private readonly decoder: FrameDecoder
  private readonly watchUnsubs = new Map<string, () => void>()
  private readonly searchCancels = new Map<string, () => void>()
  private streamSeq = 0

  constructor(
    private readonly api: Runtime,
    private readonly write: (line: string) => void,
    private readonly opts: RpcServerOptions = {},
  ) {
    this.decoder = new FrameDecoder(
      (frame) => {
        if (frame.t === 'req') void this.dispatch(frame)
      },
      () => { /* malformed line: ignore, never tear down the pipe */ },
    )
  }

  /** Emit the handshake. Call once, before processing input. */
  start(): void {
    const hello: HelloFrame = {
      t: 'hello',
      runtimeVersion: this.opts.hello?.runtimeVersion ?? RUNTIME_VERSION,
      protocolVersion: this.opts.hello?.protocolVersion ?? RUNTIME_PROTOCOL_VERSION,
      node: this.opts.hello?.node ?? {
        version: process.versions.node,
        modules: Number(process.versions.modules),
      },
      os: this.opts.hello?.os ?? {
        platform: process.platform,
        arch: process.arch,
        libc: 'unknown',
      },
    }
    this.write(serializeFrame(hello))
  }

  /** Feed raw bytes from the input pipe. */
  handleChunk(chunk: string | Buffer): void {
    this.decoder.push(chunk)
  }

  /** Tear down any active subscriptions (call on disconnect). */
  dispose(): void {
    for (const unsub of this.watchUnsubs.values()) {
      try { unsub() } catch { /* ignore */ }
    }
    this.watchUnsubs.clear()
    for (const cancel of this.searchCancels.values()) {
      try { cancel() } catch { /* ignore */ }
    }
    this.searchCancels.clear()
  }

  private async dispatch(req: ReqFrame): Promise<void> {
    try {
      const data = await this.invoke(req.method, req.params)
      this.write(serializeFrame({ t: 'res', id: req.id, ok: true, data }))
    } catch (err) {
      this.write(
        serializeFrame({
          t: 'res',
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  private async invoke(method: string, p: unknown[]): Promise<unknown> {
    const { api } = this
    const s = (i: number) => p[i] as string
    const n = (i: number) => p[i] as number | undefined
    // JSON turns a trailing `undefined` into `null`; normalize back so optional
    // access-context params behave like a genuinely omitted argument.
    const a = (i: number) => (p[i] ?? undefined) as FileAccessContext | undefined

    switch (method) {
      case Methods.ping:
        return 'pong'

      // --- validation ---
      // scopeId is the trailing positional arg and is REQUIRED: a request that
      // omits it validates against an empty root set (per-window grants can
      // still admit it), and addAllowedRoot/removeAllowedRoot reject outright.
      // Version skew can't reach here — a client/daemon version mismatch
      // triggers a re-push (see version.ts), so no older client is tolerated.
      case Methods.validatePath: return api.validatePath(s(0), n(1), s(2))
      case Methods.validatePathStrict: return api.validatePathStrict(s(0), n(1), s(2))
      case Methods.validatePathForCreation: return api.validatePathForCreation(s(0), n(1), s(2))
      case Methods.validateCwd: return api.validateCwd(s(0), n(1), s(2))
      case Methods.addAllowedRoot: return api.addAllowedRoot(s(0), s(1))
      case Methods.removeAllowedRoot: return api.removeAllowedRoot(s(0), s(1))
      case Methods.setExclusions: return api.setExclusions(p[0] as string[])
      case Methods.setIdleSuspend: return api.setIdleSuspend(p[0] as boolean)
      case Methods.grantFileAccess: return api.grantFileAccess(s(0), n(1) as number)
      case Methods.registerScopedWriteAllowance: return api.registerScopedWriteAllowance(s(0), n(1) as number)
      case Methods.clearFileGrantsForWindow: return api.clearFileGrantsForWindow(n(0) as number)
      case Methods.clearScopedWriteAllowancesForWindow: return api.clearScopedWriteAllowancesForWindow(n(0) as number)

      // --- file ---
      case Methods.fileReadFile: return api.file.readFile(s(0), p[1] as FileAccessContext | undefined)
      case Methods.fileReadBinary: return (await api.file.readBinary(s(0), p[1] as FileAccessContext | undefined)).toString('base64')
      case Methods.fileWriteFile: return api.file.writeFile(s(0), s(1), p[2] as FileAccessContext | undefined)
      case Methods.fileWriteBinary: return api.file.writeBinary(s(0), Buffer.from(s(1), 'base64'), p[2] as FileAccessContext | undefined)
      case Methods.fileReadDir: return api.file.readDir(s(0), p[1] as FileAccessContext | undefined)
      case Methods.fileStat: return api.file.stat(s(0), p[1] as FileAccessContext | undefined)
      case Methods.fileRemove: return api.file.remove(s(0), p[1] as FileAccessContext | undefined)
      case Methods.fileRename: return api.file.rename(s(0), s(1), p[2] as FileAccessContext | undefined)
      case Methods.fileMkdir: return api.file.mkdir(s(0), p[1] as FileAccessContext | undefined)
      case Methods.fileExtensionsRoot: return api.file.extensionsRoot()
      case Methods.fileExtractArtifact: return api.file.extractArtifact(s(0), s(1))
      case Methods.fileCopy: return api.file.copy(s(0), s(1), p[2] as FileAccessContext | undefined)
      case Methods.fileImportEntries:
        return api.file.importEntries(p[0] as string[], s(1), p[2] as 'copy' | 'move', p[3] as FileAccessContext | undefined)
      case Methods.fileSearch:
        // JSON turns a trailing `undefined` arg into `null`; restore undefined
        // so search's default-parameter ({}) applies.
        return api.file.search(s(0), s(1), (p[2] ?? undefined) as never, p[3] as FileAccessContext | undefined)
      case Methods.fileSearchContentStart: return this.startSearch(s(0), p[1] as SearchOptions, p[2] as FileAccessContext | undefined)
      case Methods.fileSearchContentStop: return this.stopSearch(s(0))
      case Methods.fileWatchStart: return this.startWatch(s(0), p[1] as FileAccessContext | undefined)
      case Methods.fileWatchStop: return this.stopWatch(s(0))

      // --- process (pty) --- data/exit stream back keyed by the pty id ---
      case Methods.ptyCreate:
        return api.process.create(
          p[0] as never,
          (id, data) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'data', data } })),
          (id, exitCode) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'exit', exitCode } })),
        )
      case Methods.ptyWrite: return api.process.write(s(0), s(1))
      case Methods.ptyResize: return api.process.resize(s(0), n(1) as number, n(2) as number)
      case Methods.ptyKill: return api.process.kill(s(0))
      case Methods.ptyGetCwd: return api.process.getCwd(s(0))
      case Methods.ptySetVisibility: return api.process.setVisibility(s(0), p[1] as boolean)
      case Methods.ptyScanActivity: return api.process.scanActivity(p[0] as string[])
      case Methods.ptyScanPorts: return api.process.scanPorts(p[0] as string[])

      // --- agent (pi) --- line/exit stream back keyed by the agent id ---
      case Methods.agentEnsurePi: return api.agent.ensurePi()
      case Methods.agentStart:
        return api.agent.start(
          p[0] as never,
          (id, line) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'line', line } })),
          (id, code, stderr) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'exit', code, stderr } })),
        )
      case Methods.agentWriteLine: return api.agent.writeLine(s(0), s(1))
      case Methods.agentStop: return api.agent.stop(s(0))

      // --- server (server-backed extensions) --- output/exit stream back keyed by the server id ---
      case Methods.serverStart:
        return api.server.start(
          p[0] as never,
          (id, stream, chunk) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'output', stream, chunk } })),
          (id, code, signal) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'exit', code, signal } })),
        )
      case Methods.serverStop: return api.server.stop(s(0))

      // --- tunnel (raw TCP bridge) --- data/close stream back keyed by the connId ---
      case Methods.tunnelOpen:
        return api.tunnel.open(
          s(0),
          n(1) as number,
          (id, chunk) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'data', chunk } })),
          (id) => this.write(serializeFrame({ t: 'evt', streamId: id, payload: { kind: 'close' } })),
        )
      case Methods.tunnelWrite: return api.tunnel.write(s(0), s(1))
      case Methods.tunnelAck: return api.tunnel.ack(s(0), n(1) as number)
      case Methods.tunnelClose: return api.tunnel.close(s(0))

      // --- reverse tunnel (CATE_API) --- connection evts on the listenerId
      // stream; accepted-connection bytes use data/close on the connId stream.
      case Methods.tunnelListen:
        return api.tunnel.listen(
          s(0),
          (connId) => this.write(serializeFrame({ t: 'evt', streamId: s(0), payload: { kind: 'connection', connId } })),
          (connId, chunk) => this.write(serializeFrame({ t: 'evt', streamId: connId, payload: { kind: 'data', chunk } })),
          (connId) => this.write(serializeFrame({ t: 'evt', streamId: connId, payload: { kind: 'close' } })),
        )
      case Methods.tunnelStopListen: return api.tunnel.stopListen(s(0))

      // --- vcs --- (trailing arg carries the FileAccessContext, like file.*;
      // the capability validates the cwd against its scopeId)
      case Methods.vcsIsRepo: return api.vcs.isRepo(s(0), a(1))
      case Methods.vcsFindRepos: return api.vcs.findRepos(s(0), n(1), a(2))
      case Methods.vcsInit: return api.vcs.init(s(0), a(1))
      case Methods.vcsLsFiles: return api.vcs.lsFiles(s(0), a(1))
      case Methods.vcsStatus: return api.vcs.status(s(0), a(1))
      case Methods.vcsDiff: return api.vcs.diff(s(0), p[1] as string | undefined, a(2))
      case Methods.vcsDiffStaged: return api.vcs.diffStaged(s(0), p[1] as string | undefined, a(2))
      case Methods.vcsMonitorStatus: return api.vcs.monitorStatus(s(0), a(1))
      case Methods.vcsStage: return api.vcs.stage(s(0), s(1), a(2))
      case Methods.vcsUnstage: return api.vcs.unstage(s(0), s(1), a(2))
      case Methods.vcsCommit: return api.vcs.commit(s(0), s(1), a(2))
      case Methods.vcsPush: return api.vcs.push(s(0), p[1] as string | undefined, p[2] as string | undefined, a(3))
      case Methods.vcsPull: return api.vcs.pull(s(0), p[1] as string | undefined, p[2] as string | undefined, a(3))
      case Methods.vcsFetch: return api.vcs.fetch(s(0), p[1] as string | undefined, a(2))
      case Methods.vcsLog: return api.vcs.log(s(0), n(1), a(2))
      case Methods.vcsBranchList: return api.vcs.branchList(s(0), a(1))
      case Methods.vcsBranchCreate: return api.vcs.branchCreate(s(0), s(1), p[2] as string | undefined, a(3))
      case Methods.vcsBranchDelete: return api.vcs.branchDelete(s(0), s(1), p[2] as boolean | undefined, a(3))
      case Methods.vcsCheckout: return api.vcs.checkout(s(0), s(1), a(2))
      case Methods.vcsStash: return api.vcs.stash(s(0), p[1] as string | undefined, a(2))
      case Methods.vcsStashPop: return api.vcs.stashPop(s(0), a(1))
      case Methods.vcsDiscardFile: return api.vcs.discardFile(s(0), s(1), a(2))
      case Methods.vcsWorktreeList: return api.vcs.worktreeList(s(0), a(1))
      case Methods.vcsWorktreeAdd:
        return api.vcs.worktreeAdd(s(0), s(1), s(2), p[3] as never, a(4))
      case Methods.vcsWorktreeAddFromPr: return api.vcs.worktreeAddFromPr(s(0), n(1) as number, s(2), p[3] as never, a(4))
      case Methods.vcsWorktreeRemove: return api.vcs.worktreeRemove(s(0), s(1), p[2] as never, a(3))
      case Methods.vcsWorktreePrune: return api.vcs.worktreePrune(s(0), a(1))
      case Methods.vcsWorktreeStatus: return api.vcs.worktreeStatus(s(0), a(1))
      case Methods.vcsWorktreeMergeTo: return api.vcs.worktreeMergeTo(s(0), s(1), s(2), a(3))
      case Methods.vcsWorktreeUpdateFrom: return api.vcs.worktreeUpdateFrom(s(0), s(1), a(2))
      case Methods.vcsCreatePr: return api.vcs.createPr(s(0), s(1), a(2))
      case Methods.vcsPrStatus: return api.vcs.prStatus(s(0), s(1), a(2))
      case Methods.vcsPrList: return api.vcs.prList(s(0), a(1))

      default:
        throw new Error(`Unknown runtime method: ${method}`)
    }
  }

  private startSearch(root: string, opts: SearchOptions, access?: FileAccessContext): string {
    const streamId = `s${++this.streamSeq}`
    const handle = this.api.file.searchContent(root, opts, {
      onBatch: (files) => {
        const payload: SearchEvtPayload = { kind: 'batch', files }
        this.write(serializeFrame({ t: 'evt', streamId, payload }))
      },
      onDone: (stats, error) => {
        const payload: SearchEvtPayload = { kind: 'done', stats, error }
        this.write(serializeFrame({ t: 'evt', streamId, payload }))
        this.searchCancels.delete(streamId)
      },
    }, access)
    this.searchCancels.set(streamId, handle.cancel)
    return streamId
  }

  private stopSearch(streamId: string): void {
    const cancel = this.searchCancels.get(streamId)
    if (cancel) {
      try { cancel() } finally { this.searchCancels.delete(streamId) }
    }
  }

  private startWatch(prefix: string, access?: FileAccessContext): string {
    const streamId = `w${++this.streamSeq}`
    const unsub = this.api.file.watch(prefix, (changedPath, type) => {
      const payload: FsWatchEvtPayload = { changedPath, type }
      this.write(serializeFrame({ t: 'evt', streamId, payload }))
    }, access)
    this.watchUnsubs.set(streamId, unsub)
    return streamId
  }

  private stopWatch(streamId: string): void {
    const unsub = this.watchUnsubs.get(streamId)
    if (unsub) {
      try { unsub() } finally { this.watchUnsubs.delete(streamId) }
    }
  }
}
