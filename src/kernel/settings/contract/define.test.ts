import { describe, expect, expectTypeOf, it } from 'vitest'
import { composeSettings, defineSettings, numberIn, oneOf, setting } from './define'
import { clientSettingsTable, workspaceSettingsTable, type ClientSettings, type WorkspaceSettings } from './composed'

describe('defineSettings composition', () => {
  const a = defineSettings({ scope: 'client', keys: { size: setting(12, numberIn(8, 32, { integer: true })), name: setting('') } })
  const b = defineSettings({ scope: 'client', keys: { mode: setting<'x' | 'y'>('x', oneOf('x', 'y')) } })
  const w = defineSettings({ scope: 'workspace', keys: { on: setting(true) } })

  it('composes one scope, with defaults and validation', () => {
    const table = composeSettings<{ size: number; name: string; mode: 'x' | 'y' }>('client', [a, b, w])
    expect(table.keys).toEqual(['size', 'name', 'mode'])
    expect(table.defaults).toEqual({ size: 12, name: '', mode: 'x' })
    expect(table.validate('size', 20)).toBe(true)
    expect(table.validate('size', 20.5)).toBe(false)
    expect(table.validate('size', '20')).toBe(false)
    expect(table.validate('size', Number.NaN)).toBe(false)
    expect(table.validate('mode', 'z')).toBe(false)
    expect(table.validate('on', true)).toBe(false)
    expect(table.normalize({ size: 40, name: 'n', mode: 'y', extra: 1 })).toEqual({ size: 12, name: 'n', mode: 'y' })
    expect(table.normalize('garbage')).toEqual(table.defaults)
  })

  it('refuses a key declared twice', () => {
    const dup = defineSettings({ scope: 'client', keys: { name: setting('x') } })
    expect(() => composeSettings('client', [a, dup])).toThrow(/declared twice/)
  })
})

describe('composed slices', () => {
  it('keep the scopes disjoint', () => {
    const workspace = new Set<string>(workspaceSettingsTable.keys)
    for (const key of clientSettingsTable.keys) expect(workspace.has(key)).toBe(false)
  })

  it('default the runtime keys and validate agentHookInjection as one value', () => {
    expect(workspaceSettingsTable.defaults.runtimeLifetime).toBe('stopWhenIdle')
    expect(workspaceSettingsTable.defaults.runtimeNetwork).toBe('off')
    expect(workspaceSettingsTable.validate('agentHookInjection', { claude: 'on', codex: 'off' })).toBe(true)
    expect(workspaceSettingsTable.validate('agentHookInjection', { ws1: { claude: 'on' } })).toBe(false)
  })

  it('checks values', () => {
    expect(clientSettingsTable.validate('uiScale', 2)).toBe(false)
    expect(clientSettingsTable.validate('canvasGridStyle', 'dots')).toBe(true)
    expect(clientSettingsTable.validate('savedPanelRelationLabels', ['ok', ' '])).toBe(false)
    expect(clientSettingsTable.validate('customShortcuts', { nope: { key: 'k', command: true, shift: false, option: false, control: false } })).toBe(false)
    expect(workspaceSettingsTable.validate('terminalScrollback', 50)).toBe(false)
    expect(workspaceSettingsTable.validate('browserSearchEngine', 'brave')).toBe(true)
    expect(workspaceSettingsTable.validate('runtimeNetwork', 'lan')).toBe(false)
  })

  it('types the composed settings', () => {
    expectTypeOf<ClientSettings['uiScale']>().toEqualTypeOf<number>()
    expectTypeOf<ClientSettings['canvasGridStyle']>().toEqualTypeOf<'dots' | 'lines' | 'none'>()
    expectTypeOf<WorkspaceSettings['runtimeNetwork']>().toEqualTypeOf<'off' | 'sameNetwork' | 'cateConnect'>()
    expectTypeOf<WorkspaceSettings['cliEnabled']>().toEqualTypeOf<boolean>()
  })
})
