// =============================================================================
// installMcpAdapter — register the `pi-mcp-adapter` npm package in the
// workspace's pi settings so pi auto-installs and loads it on session start.
// That adapter is what gives the agent panel MCP support: on pi's `session_start`
// it reads MCP server config from (later wins) `~/.config/mcp/mcp.json`,
// `<agentDir>/mcp.json`, `<cwd>/.mcp.json`, `<cwd>/.pi/mcp.json`. The cate.mcp
// panel writes `<cwd>/.pi/mcp.json`, and pi runs with cwd = workspace root, so
// that file resolves correctly. We do NOT write mcp.json here — only register
// the adapter so those files are honoured.
//
// WHY the agent-dir settings.json (not project `.pi/settings.json`):
//   pi resolves its "global"/agent-dir settings from PI_CODING_AGENT_DIR, which
//   Cate points at `<cwd>/.cate/cate-agent`. At session start pi's resource loader
//   resolves EVERY package in settings and auto-installs the missing ones —
//   confirmed in the pinned pi source (node_modules/@earendil-works/
//   pi-coding-agent/dist): resource-loader.js `reload()` calls
//   `packageManager.resolve()` with no `onMissing`, and package-manager.js
//   `resolve()` collects packages from BOTH project ("project") and agent-dir
//   ("user") scopes, then `resolvePackageSources` installs any missing source
//   when `onMissing` is undefined. User-scope npm packages install under
//   `<agentDir>/npm/node_modules`. So writing the package into
//   `<agentDir>/settings.json` triggers auto-install-and-load exactly like the
//   documented project settings do, and keeps Cate's footprint inside
//   `.cate/cate-agent` instead of polluting the user's project `.pi/`.
//
// Failure is non-fatal here (the write is wrapped). pi's own install happens at
// startup and needs npm + network on the runtime host; if it fails while online
// pi surfaces a start error, and under `PI_OFFLINE=1` pi simply skips the
// install. See installMcpAdapter's report notes for the remote-runtime caveat.
// =============================================================================

import log from '../../main/logger'
import { hostCodingDir, hostJoin } from './codingDir'
import { createIdempotencyTracker } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

/** pi package spec for the MCP adapter (unscoped npm package). */
export const MCP_ADAPTER_PACKAGE = 'npm:pi-mcp-adapter'

type PiSettings = Record<string, unknown>

/** True when `entry` (a pi `packages[]` element) already references the adapter,
 *  matching the bare spec, a version-pinned spec (`npm:pi-mcp-adapter@1.2.3`),
 *  or the object form (`{ source: ... }`). */
function referencesAdapter(entry: unknown): boolean {
  const source = typeof entry === 'string'
    ? entry
    : entry && typeof entry === 'object'
      ? (entry as { source?: unknown }).source
      : undefined
  if (typeof source !== 'string') return false
  return source === MCP_ADAPTER_PACKAGE || source.startsWith(MCP_ADAPTER_PACKAGE + '@')
}

/** Ensure `MCP_ADAPTER_PACKAGE` is present in a pi settings object's `packages`
 *  array, preserving every other key and any packages the user already listed.
 *  Returns the updated settings, or null when no change is needed (already
 *  present) so the caller can skip the write. */
export function withMcpAdapter(settings: PiSettings): PiSettings | null {
  const packages = Array.isArray(settings.packages) ? settings.packages : []
  if (packages.some(referencesAdapter)) return null
  return { ...settings, packages: [...packages, MCP_ADAPTER_PACKAGE] }
}

// Keyed on runtimeId + host path so the same host path on different runtimes
// doesn't collide.
const installed = createIdempotencyTracker()

/** Idempotent — safe to call from CodingManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs (local fs path for the
 *  local runtime, POSIX path on a remote host). Host-aware via `runtime.file`,
 *  so remote workspaces are seeded too. */
export async function installMcpAdapter(runtime: Runtime, cwd: string): Promise<void> {
  const home = hostCodingDir(runtime.id, cwd)
  const key = runtime.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const settingsPath = hostJoin(runtime.id, home, 'settings.json')
    let raw: string | null = null
    try { raw = await runtime.file.readFile(settingsPath) } catch { raw = null }

    let settings: PiSettings
    if (raw == null || raw.trim() === '') {
      settings = {}
    } else {
      try {
        const parsed = JSON.parse(raw)
        // A non-object top level (array/string/number) isn't valid pi settings —
        // treat it like corrupt and don't clobber whatever the user put there.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          log.warn('[installMcpAdapter] settings.json at %s is not an object — skipping', settingsPath)
          return
        }
        settings = parsed as PiSettings
      } catch {
        log.warn('[installMcpAdapter] settings.json at %s is not valid JSON — skipping', settingsPath)
        return
      }
    }

    const next = withMcpAdapter(settings)
    if (!next) return // already registered — nothing to write
    await runtime.file.mkdir(home)
    await runtime.file.writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n')
    log.info('[installMcpAdapter] registered %s in %s', MCP_ADAPTER_PACKAGE, settingsPath)
  } catch (err) {
    log.warn('[installMcpAdapter] install failed: %O', err)
  }
}
