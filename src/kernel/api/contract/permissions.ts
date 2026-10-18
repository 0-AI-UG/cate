// Permission areas of the `cate` API (architecture 8 and 14). Each area maps
// the `read` and `control` access classes to a workspace setting; `cliEnabled`
// is the master switch. They apply to CLI callers only. The
// kernel knows no area: each module declares its own with its API.

export const CLI_MASTER_KEY = 'cliEnabled'

export type ApiAccess = 'read' | 'control'

export interface CliPermissionCell {
  /** The workspace setting that turns the cell on. */
  key: string
  /** Stable error slug returned when this cell is off. */
  code: string
  /** What the cell allows, for the settings page. */
  detail: string
}

export interface CliPermissionArea {
  /** Row label in Settings, and part of the denial text. */
  label: string
  /** An area without a read cell leaves its read methods behind the master switch only. */
  read?: CliPermissionCell
  control: CliPermissionCell
}

/** Declares a permission area. The module that owns the methods declares it
 *  in its `contract/api.ts` and passes it to `defineCateApi`; the settings
 *  page lists the areas of `CATE_API` (`cliAreasOf`). */
export function defineCliArea<const A extends CliPermissionArea>(area: A): A {
  return area
}

/** The distinct areas of some API namespaces and their methods' opt-ins, in order. */
export function cliAreasOf(
  namespaces: readonly { area?: CliPermissionArea; methods: Record<string, { optIn?: CliPermissionArea }> }[],
): CliPermissionArea[] {
  return [...new Set(namespaces.flatMap((namespace) =>
    [namespace.area, ...Object.values(namespace.methods).map((method) => method.optIn)].filter((area) => area !== undefined)))]
}

export const CLI_DISABLED_MESSAGE =
  'cli-disabled: enable Command-line control (cate CLI) in Cate Settings → CLI'

/** The cell that governs `access` in `area`, if any. */
export function cliPermissionCell(area: CliPermissionArea | undefined, access: ApiAccess): CliPermissionCell | undefined {
  if (!area) return undefined
  return access === 'read' ? area.read : area.control
}

/** Error text for a cell that is off. Names the cell so the user can fix it. */
export function cliPermissionDenied(area: CliPermissionArea, access: ApiAccess): string {
  const cell = cliPermissionCell(area, access)!
  return `${cell.code}: enable ${area.label} → ${access === 'read' ? 'Read' : 'Control'} in Cate Settings → CLI`
}

/**
 * Checks the master switch, the area cell and the cell of the method's
 * opt-in, if any. Returns the denial text, or null when allowed. `setting`
 * reads a workspace setting; anything but `true` counts as off.
 */
export function cliAccessDenied(
  area: CliPermissionArea | undefined,
  access: ApiAccess,
  setting: (key: string) => unknown,
  optIn?: CliPermissionArea,
): string | null {
  if (setting(CLI_MASTER_KEY) !== true) return CLI_DISABLED_MESSAGE
  for (const each of [area, optIn]) {
    const cell = cliPermissionCell(each, access)
    if (cell && setting(cell.key) !== true) return cliPermissionDenied(each!, access)
  }
  return null
}
