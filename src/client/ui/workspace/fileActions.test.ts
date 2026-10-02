import { beforeEach, describe, expect, it, vi } from 'vitest'

const op = vi.fn(async () => undefined)
vi.mock('@kernel/rpc/client', () => ({ tryRuntimeFor: () => ({ session: { op } }) }))
vi.mock('@client/connections', () => ({ clientHas: (feature: string) => feature === 'fileDrop' }))
vi.mock('@client/document', () => ({ documentStoreFor: () => ({ getSnapshot: () => ({ panels: {} }) }) }))
vi.mock('@client/layout/canvas', () => ({ activeCanvasId: () => null, createPanelOnCanvas: vi.fn() }))
vi.mock('@client/host', () => ({
  createPanel: vi.fn((_ws: string, _type: string, options: { filePath: string }) => `panel:${options.filePath}`),
  focusedPanelId: () => null,
  panelDefinition: () => ({ checkoutPath: () => undefined }),
  panelTypeOpening: () => 'editor',
  revealPanel: vi.fn(),
}))

const { fileViewsHost, openDroppedFiles } = await import('./fileActions')

describe('openDroppedFiles', () => {
  beforeEach(() => op.mockClear())

  it('opens a dropped search match at its line', () => {
    openDroppedFiles('ws', ['/r/a.ts'], {}, { path: '/r/a.ts', line: 12, column: 3 })
    expect(op).toHaveBeenCalledWith({ panelId: 'panel:/r/a.ts', op: { kind: 'openFile', path: '/r/a.ts', line: 12, column: 3 } })
  })

  it('opens plain dropped files without moving them', () => {
    openDroppedFiles('ws', ['/r/a.ts', '/r/b.ts'], {}, null)
    expect(op).not.toHaveBeenCalled()
  })
})

describe('fileViewsHost', () => {
  it('takes OS files with the fileDrop feature', () => {
    expect(fileViewsHost.takesOsFiles()).toBe(true)
  })
})
