// =============================================================================
// Agent capability — electron-free pi runner. Spawns `node <pi>/dist/cli.js
// --mode rpc` with PIPED stdio (NOT a pty — a pty would corrupt pi's JSONL) and
// bridges it as a duplex line channel: pi's stdout is split into lines and
// handed to onLine verbatim; writeLine feeds pi's stdin. It never parses pi's
// protocol — that lives in PiRpcClient on the client side.
//
// The host-specific bits (how pi is installed, which node runs it, base env) are
// injected so the SAME code runs locally (Electron-as-node + a local pi cache)
// and inside the daemon (the bundled node + a pulled pi cache on the host).
// =============================================================================

import { spawn, type ChildProcess } from 'child_process'
import type { AgentHost, AgentStartOptions, AgentHandle } from '../../main/runtime/types'
import { catePathEnv } from '../cateCli'

export interface AgentDeps {
  /** Install pi on this host if needed; resolves once dist/cli.js is present. */
  ensurePi: () => Promise<void>
  /** Absolute path to pi's dist/cli.js on this host (valid after ensurePi). */
  piCliPath: () => string
  /** Node binary used to run pi. */
  nodeBin: () => string
  /** Base environment for pi (merged under opts.env). */
  baseEnv: () => Record<string, string>
}

export function createAgentCapability(deps: AgentDeps): AgentHost {
  const children = new Map<string, ChildProcess>()

  return {
    ensurePi: () => deps.ensurePi(),

    async start(opts: AgentStartOptions, onLine, onExit): Promise<AgentHandle> {
      await deps.ensurePi()
      const args = [deps.piCliPath(), '--mode', 'rpc']
      if (opts.provider) args.push('--provider', opts.provider)
      if (opts.model) args.push('--model', opts.model)
      if (opts.args?.length) args.push(...opts.args)

      const child = spawn(deps.nodeBin(), args, {
        cwd: opts.cwd,
        // Put the bundled `cate` on PATH when a CLI endpoint was injected, so the
        // agent can drive the browser / call host methods from its shell tool.
        env: catePathEnv({ ...deps.baseEnv(), ...opts.env }),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.set(opts.id, child)

      // Split stdout into LF-delimited lines; forward each verbatim.
      let buf = ''
      child.stdout?.setEncoding('utf-8')
      child.stdout?.on('data', (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line) onLine(opts.id, line)
        }
      })
      // pi uses stderr for diagnostics — surface it on the host's stderr AND keep
      // the tail so an early exit can report WHY pi died (its stderr is otherwise
      // lost: on a remote host it goes to the daemon's stderr, which the client
      // only captures pre-handshake).
      let stderrTail = ''
      child.stderr?.on('data', (d: Buffer) => {
        try { process.stderr.write(d) } catch { /* ignore */ }
        stderrTail += d.toString('utf-8')
        if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192)
      })
      // A spawn failure arrives as `error`, not `close`. Always end the handle so
      // the client's start() rejects rather than hanging. Without this listener an
      // `error` would be an uncaught throw.
      child.on('error', (err) => {
        children.delete(opts.id)
        onExit(opts.id, -1, err instanceof Error ? err.message : String(err))
      })
      child.on('close', (code) => {
        children.delete(opts.id)
        onExit(opts.id, code ?? 0, stderrTail.trim() || undefined)
      })

      return { id: opts.id, pid: child.pid ?? -1 }
    },

    writeLine(id: string, line: string): void {
      const child = children.get(id)
      if (!child?.stdin) return
      try { child.stdin.write(line.endsWith('\n') ? line : line + '\n') } catch { /* stdin closed */ }
    },

    stop(id: string): void {
      const child = children.get(id)
      if (!child) return
      children.delete(id)
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 1000)
    },
  }
}
