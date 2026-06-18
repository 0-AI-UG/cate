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
  frontend?: string             // entry html for frontend-only (ignored when server present)
  server?: ExtensionServerSpec
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
 * Validate untrusted parsed JSON into a manifest, or null if unusable
 * (missing id, missing/empty panels, panel without id/label). Never throws.
 */
export function normalizeManifest(parsed: unknown): ExtensionManifest | null {
  if (!isObject(parsed)) return null
  if (!nonEmptyString(parsed.id)) return null

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

  if (nonEmptyString(parsed.version)) manifest.version = parsed.version
  if (nonEmptyString(parsed.frontend)) manifest.frontend = parsed.frontend

  const server = normalizeServer(parsed.server)
  if (server) manifest.server = server

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
