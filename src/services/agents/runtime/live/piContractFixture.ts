// Real installed Pi, controlled through its native RPC interface. Cate's
// generated project extension remains the sole source of hook payloads.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_DEFS, type AgentHookEvent } from '../../contract'
import { createLiveChangeFixture, terminateLiveProcessTree } from '../changes/liveHarness'
import { createAgentStatusMachine } from '../status'
import { createConversationResets } from '../conversationResets'
import { cleanHookEnv, configureHookCli } from './hookCliFixture'
import { createHookMockProvider, type MockHookReply } from './hookMockProvider'

export async function waitForPi(check: () => boolean | Promise<boolean>, description: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export async function piContractFixture(options: {
  reply?: (input: Record<string, unknown>, protocol: string) => MockHookReply
  settings?: Record<string, unknown>
  contextWindow?: number
  extension?: string
} = {}) {
  const provider = await createHookMockProvider({ reply: options.reply })
  const fixture = await createLiveChangeFixture('pi', cleanHookEnv())
  const events: AgentHookEvent[] = []
  let conversationResets = 0
  const resets = createConversationResets(() => { conversationResets++ })
  const status = createAgentStatusMachine(() => {})
  status.notePresence(fixture.terminalId, true, false, 'pi')
  const unsubscribe = fixture.hooks.subscribe((event) => { resets.note(event); events.push(event); status.noteHookEvent(event) })
  const auditFile = path.join(fixture.directory, 'native-events.jsonl')
  try {
    const launch = await configureHookCli('pi', fixture.directory, fixture.cwd, fixture.env, provider, 'CATE_CONTRACT')
    // Compaction is controlled explicitly in each scenario, and retries are
    // agent-level, not hidden provider-level retries.
    await writeFile(path.join(fixture.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({
      defaultProjectTrust: 'always', tuiMode: 'regular', compaction: { enabled: false }, retry: { enabled: false }, ...options.settings,
    }))
    if (options.contextWindow) {
      const file = path.join(fixture.env.PI_CODING_AGENT_DIR, 'models.json')
      const models = JSON.parse(await readFile(file, 'utf8'))
      models.providers.fixture.models[0].contextWindow = options.contextWindow
      models.providers.fixture.models[0].maxTokens = 128
      await writeFile(file, JSON.stringify(models))
    }
    await writeFile(path.join(fixture.cwd, '.pi/extensions/contract-observer.ts'), `
      import { appendFileSync } from "node:fs"
      export default function (pi) {
        for (const type of ["agent_start", "agent_end", "agent_settled", "session_before_compact", "session_compact", "session_compact_failed", "session_start", "session_shutdown", "session_tree", "session_info_changed"]) {
          pi.on(type, async (event, ctx) => {
            appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({ type, sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() }) + "\\n")
            // Leave an observable interval at every low-level run boundary.
            // A final-idle implementation based on agent_end would fail here.
            if (type === "agent_end" || type === "session_before_compact") await new Promise((resolve) => setTimeout(resolve, 200))
          })
        }
        ${options.extension ?? ''}
      }
    `)
    return {
      ...fixture, provider, events, status, launch,
      conversationResets: () => conversationResets,
      audit: async (): Promise<Array<{ type: string; sessionId: string; leafId: string | null }>> => {
        try { return (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] }
      },
      close: async () => { unsubscribe(); await fixture.close(); await provider.close() },
    }
  } catch (error) { unsubscribe(); await fixture.close(); await provider.close(); throw error }
}

type RpcRecord = { type: string; id?: string; command?: string; success?: boolean; error?: string; data?: Record<string, unknown>; [key: string]: unknown }

export async function startPiRpc(fixture: Awaited<ReturnType<typeof piContractFixture>>) {
  const child = spawn(AGENT_DEFS.pi.command, ['--mode', 'rpc', ...fixture.launch.args.slice(0, -1)], {
    cwd: fixture.cwd, env: { ...fixture.env, PWD: fixture.cwd }, stdio: 'pipe', detached: process.platform !== 'win32',
  })
  const records: RpcRecord[] = []
  let pending = '', stderr = '', failure: Error | undefined, sequence = 0
  child.on('error', (error) => { failure = error })
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      if (line.trim()) records.push(JSON.parse(line))
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_000) })
  const request = async (command: Record<string, unknown>): Promise<RpcRecord> => {
    const id = `contract-${++sequence}`
    child.stdin.write(JSON.stringify({ ...command, id }) + '\n')
    await waitForPi(() => {
      if (failure) throw failure
      if (child.exitCode !== null) throw new Error(`Pi exited: ${stderr}`)
      return records.some((record) => record.id === id && record.type === 'response')
    }, `Pi response to ${command.type}`)
    const response = records.find((record) => record.id === id && record.type === 'response')!
    if (!response.success) throw new Error(`Pi ${command.type}: ${response.error}`)
    return response
  }
  try {
    await request({ type: 'get_state' })
  } catch (error) { await terminateLiveProcessTree(child.pid); throw error }
  let closed = false
  return {
    records, request, pid: child.pid!,
    close: async () => { if (closed) return; closed = true; child.stdin.end(); await terminateLiveProcessTree(child.pid); child.stdout.destroy(); child.stderr.destroy() },
  }
}
