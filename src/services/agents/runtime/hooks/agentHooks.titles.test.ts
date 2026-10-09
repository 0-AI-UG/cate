// Native session titles for every agent CLI, end to end through the real hook
// endpoint: the CLI's own prompt-submit payload names the session, the title
// tracker reads it from that CLI's own session store on disk (the real
// readers, a temp home) and a `session-title` event carries it. The fixture
// table is total over AgentId, so a new agent is a compile error until its
// title path is covered here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENTS, type AgentHookEvent, type AgentId } from '../../contract'
import { createAgentHooks, type AgentHooks } from './agentHooks'

const nodeSqliteAvailable = typeof process.getBuiltinModule === 'function'
  && process.getBuiltinModule('node:sqlite') !== undefined

interface TitleFixture {
  sessionId: string
  /** Its session store is SQLite (needs node:sqlite). */
  sqlite?: boolean
  /** The CLI's own prompt-submit hook payload for `sessionId` in `cwd`. */
  prompt(env: FixtureEnv): Record<string, unknown>
  /** Writes (or rewrites) the title where the CLI itself keeps it. */
  writeTitle(env: FixtureEnv, title: string): void
}

interface FixtureEnv {
  home: string
  cwd: string
  sessionId: string
}

const writeFile = (file: string, content: string): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** Opens, writes and closes a SQLite store, as the CLI would between hooks. */
function sqlite(file: string, schema: string, write: (db: InstanceType<typeof import('node:sqlite').DatabaseSync>) => void): void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(schema)
    write(db)
  } finally {
    db.close()
  }
}

const claudeTranscript = ({ home, cwd, sessionId }: FixtureEnv): string =>
  path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)

const grokTranscript = ({ home, cwd, sessionId }: FixtureEnv): string =>
  path.join(home, '.grok', 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')

const FIXTURES: Record<AgentId, TitleFixture> = {
  'claude-code': {
    sessionId: '11111111-2222-4333-8444-555555555555',
    prompt: (env) => ({
      hook_event_name: 'UserPromptSubmit',
      session_id: env.sessionId,
      cwd: env.cwd,
      transcript_path: claudeTranscript(env),
    }),
    writeTitle(env, title) {
      // Claude appends ai-title records; the last one wins.
      const file = claudeTranscript(env)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: env.sessionId })}\n`, { flag: 'a' })
    },
  },
  codex: {
    sessionId: '019a0000-0000-7000-8000-000000000001',
    prompt: (env) => ({ hook_event_name: 'UserPromptSubmit', session_id: env.sessionId, cwd: env.cwd, turn_id: 'turn-1' }),
    writeTitle(env, title) {
      const file = path.join(env.home, '.codex', 'session_index.jsonl')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ id: env.sessionId, thread_name: title, updated_at: new Date().toISOString() })}\n`, { flag: 'a' })
    },
  },
  cursor: {
    sessionId: '12345678-1234-4123-8123-123456789abc',
    prompt: (env) => ({ hook_event_name: 'beforeSubmitPrompt', conversation_id: env.sessionId, workspace_roots: [env.cwd] }),
    writeTitle(env, title) {
      writeFile(
        path.join(env.home, '.cursor', 'chats', '0123456789abcdef0123456789abcdef', env.sessionId, 'meta.json'),
        JSON.stringify({ schemaVersion: 1, hasConversation: true, title, cwd: env.cwd }),
      )
    },
  },
  grok: {
    sessionId: 'grok-session-1',
    prompt: (env) => ({ hookEventName: 'user_prompt_submit', sessionId: env.sessionId, cwd: env.cwd, transcriptPath: grokTranscript(env) }),
    writeTitle(env, title) {
      const transcript = grokTranscript(env)
      writeFile(transcript, '')
      writeFile(path.join(path.dirname(transcript), 'summary.json'), JSON.stringify({ generated_title: title, title_is_manual: false }))
    },
  },
  hermes: {
    sessionId: '20260928_101500_a1b2c3',
    sqlite: true,
    prompt: (env) => ({ hook_event_name: 'pre_llm_call', session_id: env.sessionId, cwd: env.cwd, profile: 'default', platform: 'cli' }),
    writeTitle(env, title) {
      sqlite(
        path.join(env.home, '.hermes', 'state.db'),
        'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, title_source TEXT)',
        (db) => db.prepare('INSERT OR REPLACE INTO sessions (id, title, title_source) VALUES (?, ?, ?)').run(env.sessionId, title, 'llm'),
      )
    },
  },
  kiro: {
    sessionId: 'sess_12345678-1234-4123-8123-123456789abc',
    prompt: (env) => ({ hook_event_name: 'userPromptSubmit', session_id: env.sessionId, cwd: env.cwd }),
    writeTitle(env, title) {
      writeFile(
        path.join(env.home, '.kiro', 'sessions', '0123456789abcdef', env.sessionId, 'session.json'),
        JSON.stringify({ schemaVersion: '1.0.0', id: env.sessionId, title, workspacePaths: [env.cwd] }),
      )
    },
  },
  opencode: {
    sessionId: 'ses_target',
    sqlite: true,
    prompt: (env) => ({ type: 'session.status', sessionID: env.sessionId, directory: env.cwd, status: { type: 'busy' } }),
    writeTitle(env, title) {
      sqlite(
        path.join(env.home, '.local', 'share', 'opencode', 'opencode.db'),
        'CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, title TEXT NOT NULL, time_updated INTEGER NOT NULL)',
        (db) => db.prepare('INSERT OR REPLACE INTO session (id, title, time_updated) VALUES (?, ?, ?)').run(env.sessionId, title, Date.now()),
      )
    },
  },
}

let tmp = ''
let hooks: AgentHooks | null = null

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cate-agent-titles-'))
})

afterEach(() => {
  hooks?.dispose()
  hooks = null
  rmSync(tmp, { recursive: true, force: true })
})

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('native session titles for every agent CLI', () => {
  it('covers every registered agent', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(AGENTS.map((agent) => agent.id).sort())
  })

  for (const agent of AGENTS) {
    const fixture = FIXTURES[agent.id]
    it.runIf(!fixture.sqlite || nodeSqliteAvailable)(`${agent.displayName}: its prompt hook titles the terminal, and a rename follows`, async () => {
      const env: FixtureEnv = { home: path.join(tmp, 'home'), cwd: path.join(tmp, 'project'), sessionId: fixture.sessionId }
      mkdirSync(env.home, { recursive: true })
      mkdirSync(env.cwd, { recursive: true })
      hooks = createAgentHooks({
        hooksDir: path.join(tmp, 'hooks'),
        changesDir: path.join(tmp, 'changes'),
        homeDir: env.home,
        titleRetryDelaysMs: [0, 50, 200],
        approvalConfigReaders: { codex: { envKeys: [], read: async () => ({ source: 'config', mode: 'unknown', detail: 'test' }) } },
      })
      const events: AgentHookEvent[] = []
      hooks.subscribe((event) => events.push(event))
      const { url, tokenFor } = await hooks.endpoint()
      const terminalId = `pty-${agent.id}`
      const prompt = async (): Promise<void> => {
        const response = await fetch(`${url}/hook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(terminalId)}` },
          body: JSON.stringify({ agentId: agent.id, terminalId, payload: fixture.prompt(env) }),
        })
        expect(response.ok).toBe(true)
      }
      const titles = () => events.filter((event) => event.kind === 'session-title').map((event) => event.title)

      fixture.writeTitle(env, `${agent.displayName} first title`)
      await prompt()
      expect(events[0]).toMatchObject({ kind: 'turn-start', agentId: agent.id, terminalId, sessionId: fixture.sessionId })
      await waitFor(() => titles().length === 1)
      expect(events.find((event) => event.kind === 'session-title')).toMatchObject({
        terminalId,
        agentId: agent.id,
        sessionId: fixture.sessionId,
        title: `${agent.displayName} first title`,
      })

      fixture.writeTitle(env, `${agent.displayName} renamed`)
      await prompt()
      await waitFor(() => titles().length === 2)
      expect(titles()).toEqual([`${agent.displayName} first title`, `${agent.displayName} renamed`])
    })
  }
})
