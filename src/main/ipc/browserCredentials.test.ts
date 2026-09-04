import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  handle: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  disposition: vi.fn(async () => 'create' as 'create' | 'update' | 'unchanged'),
  save: vi.fn(async () => ({
    action: 'created' as const,
    credential: { id: 'credential-1', origin: 'https://example.com', username: 'person@example.com' },
  })),
}))

const owner = { isDestroyed: vi.fn(() => false) }

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => owner) },
  dialog: { showMessageBox: mocks.showMessageBox, showOpenDialog: vi.fn() },
  ipcMain: { on: mocks.on, handle: mocks.handle },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
}))
vi.mock('../browser/browserCredentials', () => ({
  clearBrowserCredentials: vi.fn(),
  getBrowserCredentials: vi.fn(),
  getBrowserCredentialProfiles: vi.fn(),
  getCredentialForFill: vi.fn(),
  getCredentialSaveDisposition: mocks.disposition,
  getCredentialSuggestions: vi.fn(),
  importChromePasswordCsv: vi.fn(),
  importChromePasswords: vi.fn(),
  removeBrowserCredential: vi.fn(),
  saveBrowserCredential: mocks.save,
}))
vi.mock('../browser/browserRuntime', () => ({
  browserRuntime: { isRegistered: vi.fn(() => true), fillCredential: vi.fn() },
}))
vi.mock('./handlerError', () => ({ wrapHandler: (_label: string, handler: unknown) => handler }))
vi.mock('./browserControl', () => ({ resolveBrowserGuest: vi.fn() }))

import { registerBrowserCredentialHandlers } from './browserCredentials'

const contents = {
  id: 42,
  getType: () => 'webview',
  isDestroyed: () => false,
}

function submitListener(): (event: unknown, request: unknown) => void {
  const registration = mocks.on.mock.calls.find(([channel]) => channel === 'cate-browser-password-submit')
  if (!registration) throw new Error('password submit listener was not registered')
  return registration[1]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.showMessageBox.mockResolvedValue({ response: 0 })
  mocks.disposition.mockResolvedValue('create')
  registerBrowserCredentialHandlers()
})

describe('browser password submission', () => {
  it('requires native confirmation before saving an agent-submitted credential', async () => {
    submitListener()({ sender: contents }, {
      origin: 'https://example.com/login',
      username: 'person@example.com',
      password: 'secret',
      usernameElement: 'email',
      passwordElement: 'password',
      automated: true,
    })

    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    expect(mocks.showMessageBox).toHaveBeenCalledWith(owner, expect.objectContaining({
      title: 'Save password',
      buttons: ['Save', 'Not now'],
      detail: expect.stringContaining('Entered by an agent in Cate.'),
    }))
    expect(mocks.save).toHaveBeenCalledWith({
      origin: 'https://example.com/login',
      username: 'person@example.com',
      password: 'secret',
      usernameElement: 'email',
      passwordElement: 'password',
    })
  })

  it('does not save when the user declines the native prompt', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    submitListener()({ sender: contents }, {
      origin: 'https://example.com',
      username: '',
      password: 'secret',
    })

    await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledOnce())
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not prompt again for an unchanged password', async () => {
    mocks.disposition.mockResolvedValue('unchanged')
    submitListener()({ sender: contents }, {
      origin: 'https://example.com',
      username: 'person@example.com',
      password: 'secret',
    })

    await vi.waitFor(() => expect(mocks.disposition).toHaveBeenCalledOnce())
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
