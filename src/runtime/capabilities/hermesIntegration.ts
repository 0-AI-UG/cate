import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PLUGIN_ID = 'cate-agent-state'
const OWNER_FILE = '.cate-managed.json'
const OWNER_SENTINEL = '{"schema":1,"owner":"Cate","plugin":"cate-agent-state"}'
const SAFE_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const HERMES_PLUGIN_MANIFEST = `name: ${PLUGIN_ID}
version: 2.0.0
description: "Connect Hermes terminal lifecycle, approvals, edits, and context to Cate."
author: "Cate"
provides_hooks:
  - on_session_start
  - on_session_reset
  - pre_llm_call
  - on_session_end
  - on_session_finalize
  - pre_approval_request
  - post_approval_response
  - post_tool_call
`

// Kept inline so the same runtime bundle installs it on local, SSH, and WSL
// hosts; no source checkout or app-side filesystem path is involved.
export const HERMES_PLUGIN_SOURCE = String.raw`"""Cate bridge for Hermes terminal sessions."""
import json
import os
import re
import time
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_PROCESS_STARTED_AT = str(time.monotonic_ns())
class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

_OPENER = build_opener(ProxyHandler({}), _RejectRedirects())
_COMMON_KEYS = {
    "session_id", "task_id", "turn_id", "api_request_id", "platform",
    "completed", "failed", "interrupted", "turn_exit_reason", "reason",
    "old_session_id", "new_session_id",
}
_TOOL_KEYS = {
    "tool_name", "args", "result", "tool_call_id", "duration_ms", "status",
    "error_type", "error_message",
}

def _connection():
    if os.environ.get("CATE_HERMES_HOOKS") != "1":
        return None
    endpoint = os.environ.get("CATE_HOOK_ENDPOINT", "")
    token = os.environ.get("CATE_HOOK_TOKEN", "")
    terminal_id = os.environ.get("CATE_TERMINAL_ID", "")
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return None
    if (not token or not terminal_id or parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "::1"}):
        return None
    return endpoint, token, terminal_id

def _report(name, profile, **kwargs):
    connection = _connection()
    if connection is None or not _PROFILE_RE.fullmatch(profile):
        return None
    platform = str(kwargs.get("platform") or "")
    if platform and platform not in {"cli", "tui"}:
        return None
    endpoint, token, terminal_id = connection
    # pre_llm_call also carries the user's message and entire conversation
    # history. Cate needs neither; keep the bridge's data boundary limited to
    # lifecycle identity and post-tool change evidence.
    allowed = _COMMON_KEYS | (_TOOL_KEYS if name == "post_tool_call" else set())
    payload = {key: value for key, value in kwargs.items() if key in allowed}
    payload.update({
        "hook_event_name": name,
        "profile": profile,
        "platform": platform,
        "cwd": os.getcwd(),
    })
    body = json.dumps({
        "agentId": "hermes",
        "terminalId": terminal_id,
        "pid": os.getpid(),
        "processStartedAt": _PROCESS_STARTED_AT,
        "payload": payload,
    }, default=str, separators=(",", ":")).encode("utf-8")
    try:
        request = Request(endpoint + "/hook", data=body, headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        }, method="POST")
        with _OPENER.open(request, timeout=0.75) as response:
            output = response.read().decode("utf-8")
        if name == "pre_llm_call" and output:
            return {"context": output}
    except Exception:
        pass
    return None

def _callback(name, profile):
    def report(**kwargs):
        return _report(name, profile, **kwargs)
    return report

def register(ctx):
    profile = str(getattr(ctx, "profile_name", "default"))
    for name in (
        "on_session_start", "on_session_reset", "pre_llm_call",
        "on_session_end", "on_session_finalize", "pre_approval_request",
        "post_approval_response", "post_tool_call",
    ):
        ctx.register_hook(name, _callback(name, profile))
`

function profileArgs(profile?: string): string[] {
  if (profile === undefined) return []
  if (!SAFE_PROFILE.test(profile) || profile === 'custom') throw new Error(`Invalid Hermes profile: ${profile}`)
  return ['--profile', profile]
}

async function runHermes(profile: string | undefined, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'HERMES_HOME'))
  const { stdout } = await execFileAsync('hermes', [...profileArgs(profile), ...args], {
    env,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

async function targetFor(profile?: string): Promise<string> {
  const config = (await runHermes(profile, ['config', 'path'])).trim()
  if (!path.isAbsolute(config)) throw new Error('Hermes returned an invalid profile config path')
  return path.join(path.dirname(config), 'plugins', PLUGIN_ID)
}

async function ownership(target: string): Promise<'missing' | 'managed' | 'foreign'> {
  try {
    const info = await lstat(target)
    if (!info.isDirectory() || info.isSymbolicLink()) return 'foreign'
    return (await readFile(path.join(target, OWNER_FILE), 'utf8').catch(() => '')) === OWNER_SENTINEL
      ? 'managed'
      : 'foreign'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

export async function inspectHermesIntegration(profile?: string): Promise<boolean> {
  try {
    const rows = JSON.parse(await runHermes(profile, ['plugins', 'list', '--enabled', '--json']))
    return Array.isArray(rows) && rows.some((row) => row?.name === PLUGIN_ID && row?.status === 'enabled')
  } catch {
    return false
  }
}

export async function ensureHermesIntegration(profile?: string): Promise<void> {
  const target = await targetFor(profile)
  const owner = await ownership(target)
  if (owner === 'foreign') throw new Error(`${target} exists and is not managed by Cate`)
  const wasEnabled = owner === 'managed' && await inspectHermesIntegration(profile)
  const pluginsDir = path.dirname(target)
  await mkdir(pluginsDir, { recursive: true })
  const staging = await mkdtemp(path.join(pluginsDir, `.${PLUGIN_ID}-`))
  const backup = path.join(pluginsDir, `.${PLUGIN_ID}-backup-${randomUUID()}`)
  let backedUp = false
  try {
    await writeFile(path.join(staging, 'plugin.yaml'), HERMES_PLUGIN_MANIFEST)
    await writeFile(path.join(staging, '__init__.py'), HERMES_PLUGIN_SOURCE)
    await writeFile(path.join(staging, OWNER_FILE), OWNER_SENTINEL)
    if (owner === 'managed') {
      await rename(target, backup)
      backedUp = true
    }
    await rename(staging, target)
    await runHermes(profile, ['plugins', 'enable', PLUGIN_ID, '--no-allow-tool-override'])
    if (!(await inspectHermesIntegration(profile))) throw new Error('Hermes did not enable the Cate plugin')
    if (backedUp) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
    if (backedUp) await rename(backup, target).catch(() => {})
    // Roll back Hermes's enabled-plugin registry as well as the files. A
    // failed first install must not leave a dangling enabled entry; replacing
    // an existing working install restores its prior enabled state.
    if (backedUp && wasEnabled) {
      await runHermes(profile, ['plugins', 'enable', PLUGIN_ID, '--no-allow-tool-override']).catch(() => {})
    } else if (!backedUp) {
      await runHermes(profile, ['plugins', 'disable', PLUGIN_ID]).catch(() => {})
    }
    throw error
  }
}
