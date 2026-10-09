// Workspace data: identity and file names. Pure.

import { sha256 } from '@noble/hashes/sha2.js'
import { base32Encode, utf8Encode } from '../security/contract'

export const RUNTIME_ID_LENGTH = 16

/** First 16 characters of the lowercase base32 SHA-256 of the canonical (realpath'd) root. */
export function runtimeIdFromCanonicalRoot(canonicalRoot: string): string {
  return base32Encode(sha256(utf8Encode(canonicalRoot))).slice(0, RUNTIME_ID_LENGTH)
}

export function isRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z2-7]{16}$/.test(value)
}

/** The local transport on Windows; elsewhere it is `runtime.sock` in the data
 *  dir. `userKey` is a random part only this user can read (Node cannot set a
 *  pipe's ACL), so another user can neither guess the name nor take it. */
export function windowsPipeName(runtimeId: string, userKey: string): string {
  return `\\\\.\\pipe\\cate-${userKey}-${runtimeId}`
}

export interface RuntimeEndpoints {
  local: string
  /** LAN WebSocket, when network access is on. */
  sameNetwork?: { port: number; addresses: string[] }
  /** The Cate Connect service the runtime registers with. */
  cateConnect?: { url: string }
}

/** `runtime.json`, written after the daemon binds its socket. */
export interface RuntimeInfo {
  runtimeId: string
  root: string
  pid: number
  version: string
  /** The daemon's build (`scripts/build-id.mjs`), when bundled: its install
   *  `~/.cate/runtime/<build>/` is kept while it runs. */
  build?: string
  protocol: [number, number]
  endpoints: RuntimeEndpoints
}

/** A stopping daemon gives up on a stuck shutdown and exits after this long,
 *  so a new daemon can wait that long for the previous one to be gone. */
export const RUNTIME_STOP_DEADLINE_MS = 5_000

// File and folder names inside ~/.cate/workspaces/<runtimeId>/ (section 7.2).
export const DATA_FILES = {
  socket: 'runtime.sock',
  runtimeInfo: 'runtime.json',
  document: 'document.json',
  sessions: 'sessions',
  buffers: 'buffers',
  settings: 'settings.json',
  secrets: 'secrets.json',
  devices: 'devices.json',
  push: 'push.json',
  trust: 'trust.json',
  grants: 'grants.json',
  skills: 'skills',
  skillSources: 'skills/sources.json',
  browser: 'browser',
  t3: 't3',
  agents: 'agents',
  terminalLogs: 'terminal-logs',
  screenshots: 'screenshots',
  logs: 'logs',
} as const
