// =============================================================================
// Extension manifest contract — shared between main and renderer.
//
// Pure and dependency-free (except ./types). Defines the manifest shape an
// extension ships (see docs/extensions.md) plus defensive helpers that turn
// untrusted parsed JSON into a usable manifest without ever throwing.
// =============================================================================

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

/** Default HTTP path Cate probes to decide a server-backed extension is ready. */
export const DEFAULT_READY_PATH = '/health'
/** Default env var Cate uses to hand the chosen free port to a server. */
export const DEFAULT_PORT_ENV = 'PORT'

// -----------------------------------------------------------------------------
// Manifest shape
// -----------------------------------------------------------------------------

export interface ExtensionPanelDef {
  id: string
  label: string
  icon?: string                 // optional inline SVG or icon name
  defaultSize?: { width: number; height: number }
}

export interface ExtensionServerSpec {
  command: string               // e.g. "node dist/server.js"
  readyPath?: string            // default "/health"
  portEnv?: string              // default "PORT"
}

export interface ExtensionManifest {
  id: string                    // e.g. "acme.example"
  name: string
  version?: string
  panels: ExtensionPanelDef[]
  frontend?: string             // entry html for frontend-only (ignored when server/url present)
  server?: ExtensionServerSpec
  url?: string                  // remote https page the panel points at (see normalizeUrl)
  cateApi?: string[]            // declared cate.* scopes
}

// -----------------------------------------------------------------------------
// Registry entry
// -----------------------------------------------------------------------------

/** One extension as known to the main-process registry. Returned by
 *  `electronAPI.extensionList()` and consumed by the renderer's extensions UI. */
export interface ExtensionListEntry {
  manifest: ExtensionManifest
  /** Whether the extension is currently enabled (in `enabledExtensions`). */
  enabled: boolean
  /** Where this extension came from. `catalog` extensions originate from a
   *  remote catalog source; `sideload` ones from a local dev folder. */
  source: 'catalog' | 'sideload'
  /** Absolute path to the folder whose assets are served (holds manifest.json). */
  rootDir: string
  /** Whether the extension's assets are installed locally. Catalog entries can
   *  be listed (browsable) without being installed yet; sideloaded entries are
   *  always installed. */
  installed: boolean
  /** Catalog-advertised version (may differ from an installed manifest). */
  version?: string
  /** The version actually extracted on disk (catalog entries only); undefined
   *  when not installed. May lag `version` after a catalog refresh. */
  installedVersion?: string
  /** Installed, but the catalog now advertises a newer version than the one on
   *  disk — the UI can offer an Update action. */
  updateAvailable?: boolean
  /** Catalog-advertised short description. */
  description?: string
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// An extension `id`/`version` flows into `path.join()` calls that resolve the
// extension's on-disk staging/storage folders. Anything containing a path
// separator, a `..` traversal, or a NUL could escape the extensions dir and
// enable arbitrary file writes/deletes or cross-extension storage reads. Reject
// such values here — the single manifest chokepoint — so every downstream path
// use is safe by construction.
//
// A safe id is a strict slug: alphanumeric-led, then only `A-Za-z0-9._-`. Dots
// are allowed because real ids look like `acme.example` / `cate.frontendkit`.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// A version may additionally carry `+` for semver build metadata.
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/

/** True if `value` is a non-empty, filesystem-safe extension id. */
function isSafeId(value: unknown): value is string {
  return nonEmptyString(value) && SAFE_ID.test(value)
}

/** True if `value` is a non-empty, filesystem-safe extension version. */
function isSafeVersion(value: unknown): value is string {
  return nonEmptyString(value) && SAFE_VERSION.test(value)
}

/** Normalize one untrusted panel entry, or null if it lacks id/label. */
function normalizePanel(parsed: unknown): ExtensionPanelDef | null {
  if (!isObject(parsed)) return null
  if (!nonEmptyString(parsed.id) || !nonEmptyString(parsed.label)) return null

  const panel: ExtensionPanelDef = { id: parsed.id, label: parsed.label }
  if (nonEmptyString(parsed.icon)) panel.icon = parsed.icon

  const size = parsed.defaultSize
  if (
    isObject(size) &&
    typeof size.width === 'number' &&
    typeof size.height === 'number'
  ) {
    panel.defaultSize = { width: size.width, height: size.height }
  }
  return panel
}

/** Normalize the optional server spec, applying defaults for missing fields. */
function normalizeServer(parsed: unknown): ExtensionServerSpec | undefined {
  if (!isObject(parsed)) return undefined
  if (!nonEmptyString(parsed.command)) return undefined
  return {
    command: parsed.command,
    readyPath: nonEmptyString(parsed.readyPath) ? parsed.readyPath : DEFAULT_READY_PATH,
    portEnv: nonEmptyString(parsed.portEnv) ? parsed.portEnv : DEFAULT_PORT_ENV,
  }
}

/**
 * Normalize the optional remote-page URL (url mode), or undefined if unusable.
 *
 * Only `https:` is accepted. A manifest is untrusted input that ends up as a
 * top-level webview `src`, so anything else is a foot-gun or an escalation:
 * `file:`/`javascript:`/`data:` would run attacker-chosen content in the
 * extension's persistent session partition, and plain `http:` (localhost
 * included — a url extension is meant for hosted SaaS, and a local dev server is
 * what `server` mode is for) would be a cleartext page inside the app.
 */
function normalizeUrl(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  return value
}

/**
 * Validate untrusted parsed JSON into a manifest, or null if unusable
 * (missing id, missing/empty panels, panel without id/label). Never throws.
 */
export function normalizeManifest(parsed: unknown): ExtensionManifest | null {
  if (!isObject(parsed)) return null
  // Reject unusable (missing) or filesystem-unsafe ids — the id resolves paths.
  if (!isSafeId(parsed.id)) return null

  if (!Array.isArray(parsed.panels) || parsed.panels.length === 0) return null
  const panels: ExtensionPanelDef[] = []
  for (const raw of parsed.panels) {
    const panel = normalizePanel(raw)
    if (!panel) return null
    panels.push(panel)
  }

  const manifest: ExtensionManifest = {
    id: parsed.id,
    // Fall back to the id so a manifest missing a display name is still usable.
    name: nonEmptyString(parsed.name) ? parsed.name : parsed.id,
    panels,
  }

  // Drop an unsafe version (treat as absent) rather than nulling the whole
  // manifest; downstream code falls back to '0.0.0'. An unsafe version must
  // never reach a path.
  if (isSafeVersion(parsed.version)) manifest.version = parsed.version
  if (nonEmptyString(parsed.frontend)) manifest.frontend = parsed.frontend

  const server = normalizeServer(parsed.server)
  if (server) manifest.server = server

  // Mode precedence when a manifest declares more than one backend:
  // `server` > `url` > `frontend`. A mixed manifest is kept (rather than
  // rejected) so a badly-written one still loads; the resolver in
  // main/extensions/proxyServer.ts picks the winner by this order.
  const url = normalizeUrl(parsed.url)
  if (url) manifest.url = url

  if (Array.isArray(parsed.cateApi)) {
    const scopes = parsed.cateApi.filter((s): s is string => typeof s === 'string')
    if (scopes.length > 0) manifest.cateApi = scopes
  }

  return manifest
}

/** Resolve display metadata for one extension panel; null if not found. */
export function resolveExtensionPanelMeta(
  manifest: ExtensionManifest | undefined,
  extensionPanelId: string,
): ExtensionPanelDef | null {
  if (!manifest) return null
  return manifest.panels.find((p) => p.id === extensionPanelId) ?? null
}
