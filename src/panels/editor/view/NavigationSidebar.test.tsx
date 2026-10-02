import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = vi.hoisted(() => ({ readDir: vi.fn(), unwatch: vi.fn() }))
vi.mock('@workspace/files/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/files/client')>()),
  fsClient: () => ({ readDir: h.readDir }),
  watchFsRoot: () => h.unwatch,
}))
vi.mock('@workspace/files/ui/gitTree', () => ({ useGitTree: () => undefined }))
import { NavigationSidebar } from './NavigationSidebar'

afterEach(() => { vi.clearAllMocks() })

const entry = (path: string) => ({ path, name: path.split('/').pop()!, isDirectory: false, extension: 'ts' })

async function render(element: React.ReactElement) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const sidebar = (root: string) => (
  <NavigationSidebar workspaceId="ws" panelId="p1" root={root} view="explorer" visible fill={false}
    focusToken={0} focusInput={false} onHide={() => {}} onOpenFiles={() => {}} />
)

it('loads the explorer when mounted under StrictMode', async () => {
  h.readDir.mockResolvedValue([entry('/repo/a.ts')])
  const view = await render(<StrictMode>{sidebar('/repo')}</StrictMode>)
  try {
    await act(async () => {})
    expect(view.host.textContent).not.toContain('Loading files')
    expect(view.host.querySelector('[data-filepath="/repo/a.ts"]')).not.toBeNull()
  } finally { await view.unmount() }
})

it('loads the new root when the checkout changes and stops watching the old one', async () => {
  h.readDir.mockImplementation(async (path: string) => [entry(`${path}/x.ts`)])
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(sidebar('/one')))
    await act(async () => root.render(sidebar('/two')))
    expect(host.querySelector('[data-filepath="/two/x.ts"]')).not.toBeNull()
    expect(host.querySelector('[data-filepath="/one/x.ts"]')).toBeNull()
    expect(h.unwatch).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); host.remove() }
})
