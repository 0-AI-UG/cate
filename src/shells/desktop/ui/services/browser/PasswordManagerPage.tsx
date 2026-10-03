// The browser's password manager page (chrome://password-manager). Saved
// passwords live in the runtime (`browserData`, secrets.json) and are shared by
// every client of the workspace; importing from Chrome reads this client's
// Chrome through the desktop page bridge.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Globe, Key, Search as MagnifyingGlass, Plus, Trash } from 'lucide-react'
import { clientUi, errorMessage } from '@kernel/interaction'
import { LoadingState, Spinner, SecondaryButton, Select } from '../../kernel/interaction'
import { useRuntime } from '../../kernel/rpc'
import type { BrowserChromeImport, BrowserChromeProfiles, BrowserCredentialSuggestion } from '@services/browser/contract'
import { browserPageBridge } from '@services/browser/client'

type PasswordManagerTab = 'passwords' | 'advanced'

export function BrowserPasswordManagerPage({ workspaceId }: { workspaceId: string }): JSX.Element {
  const runtime = useRuntime(workspaceId)
  const bridge = browserPageBridge()
  const [tab, setTab] = useState<PasswordManagerTab>('passwords')
  const [query, setQuery] = useState('')
  const [credentialState, setCredentialState] = useState<BrowserChromeProfiles | null>(null)
  const [credentials, setCredentials] = useState<BrowserCredentialSuggestion[]>([])
  const [selectedProfile, setSelectedProfile] = useState('')
  const [adding, setAdding] = useState(false)
  const [manualOrigin, setManualOrigin] = useState('')
  const [manualUsername, setManualUsername] = useState('')
  const [manualPassword, setManualPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    if (!runtime) return
    const [profiles, saved] = await Promise.all([
      bridge ? bridge.chromeProfiles() : Promise.resolve({ directImportSupported: false, profiles: [] }),
      runtime.browserData.passwords(),
    ])
    setCredentialState(profiles)
    setCredentials(saved)
    setSelectedProfile((current) =>
      profiles.profiles.some((profile) => profile.id === current)
        ? current
        : profiles.profiles[0]?.id ?? '')
  }, [runtime, bridge])

  useEffect(() => {
    void load().catch(() => setMessage('Could not load saved passwords.'))
  }, [load])

  const filteredCredentials = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return credentials
    return credentials.filter((credential) =>
      credential.origin.toLowerCase().includes(needle)
      || credential.username.toLowerCase().includes(needle))
  }, [credentials, query])

  /** Hands rows read on this client to the runtime. */
  const store = async (rows: BrowserChromeImport) => {
    const result = await runtime!.browserData.importPasswords({ credentials: rows.credentials })
    return { ...result, skipped: result.skipped + rows.skipped }
  }

  const importProfile = async () => {
    if (!selectedProfile || !bridge || !runtime) return
    setBusy(true)
    setMessage('')
    try {
      const result = await store(await bridge.readChromePasswords(selectedProfile))
      setMessage(`Imported ${result.imported} password${result.imported === 1 ? '' : 's'}.`)
      await load()
    } catch (error) {
      setMessage(errorMessage(error, 'Password import failed.'))
    } finally {
      setBusy(false)
    }
  }

  const importFile = async () => {
    if (!bridge || !runtime) return
    setBusy(true)
    setMessage('')
    try {
      const rows = await bridge.readChromePasswordCsv()
      if (!rows.canceled) {
        const result = await store(rows)
        setMessage(
          `Imported ${result.imported} password${result.imported === 1 ? '' : 's'}. `
          + 'Delete the plaintext export file when you no longer need it.',
        )
        await load()
      }
    } catch (error) {
      setMessage(errorMessage(error, 'Password import failed.'))
    } finally {
      setBusy(false)
    }
  }

  const removeCredential = async (id: string) => {
    await runtime?.browserData.removePassword({ id })
    setCredentials((current) => current.filter((credential) => credential.id !== id))
  }

  const saveManualCredential = async () => {
    setBusy(true)
    setMessage('')
    try {
      if (!runtime) return
      const result = await runtime.browserData.savePassword({
        input: { origin: manualOrigin, username: manualUsername, password: manualPassword },
      })
      setMessage(result.action === 'updated' ? 'Saved password updated.' : 'Password saved.')
      setManualOrigin('')
      setManualUsername('')
      setManualPassword('')
      setAdding(false)
      await load()
    } catch (error) {
      setMessage(errorMessage(error, 'Could not save password.'))
    } finally {
      setBusy(false)
    }
  }

  const cancelManualCredential = () => {
    setManualOrigin('')
    setManualUsername('')
    setManualPassword('')
    setAdding(false)
  }

  const removeAll = async () => {
    if (!await clientUi().confirm('Remove all passwords saved in this workspace?')) return
    await runtime?.browserData.clearPasswords()
    setCredentials([])
    setMessage('Saved passwords removed.')
  }

  const profiles = credentialState?.profiles ?? []

  return (
    <div
      data-browser-password-manager
      className="absolute inset-0 h-full w-full overflow-y-auto bg-surface-0 text-primary"
    >
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-10 py-10">
        <div className="mb-7 flex items-center gap-3">
          <Key size={26} className="text-secondary" />
          <h1 className="text-2xl font-semibold">Password manager</h1>
        </div>

        <div className="mb-8 flex w-fit rounded-xl bg-surface-3 p-1">
          {(['passwords', 'advanced'] as const).map((value) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`rounded-lg px-5 py-2 text-sm font-medium capitalize ${
                tab === value ? 'bg-surface-6 text-primary shadow-sm' : 'text-secondary hover:text-primary'
              }`}
            >
              {value}
            </button>
          ))}
        </div>

        {tab === 'passwords' ? (
          <>
            <div className="mb-6 flex gap-2">
              <label className="relative block flex-1">
                <MagnifyingGlass
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search passwords"
                  className="w-full rounded-lg border border-subtle bg-surface-2 py-2 pl-9 pr-3 text-sm outline-none focus:border-focus-blue"
                />
              </label>
              <SecondaryButton
                onClick={() => setAdding(true)}
                disabled={!runtime || adding}
              >
                <Plus size={14} /> Add password
              </SecondaryButton>
            </div>

            {adding && (
              <form
                className="mb-6 grid gap-3 rounded-xl border border-subtle bg-surface-1 p-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveManualCredential()
                }}
              >
                <label className="grid gap-1 text-xs text-muted">
                  Website
                  <input
                    type="url"
                    required
                    value={manualOrigin}
                    onChange={(event) => setManualOrigin(event.target.value)}
                    placeholder="https://example.com"
                    className="rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-sm text-primary outline-none focus:border-focus-blue"
                  />
                </label>
                <label className="grid gap-1 text-xs text-muted">
                  Username
                  <input
                    value={manualUsername}
                    onChange={(event) => setManualUsername(event.target.value)}
                    autoComplete="off"
                    className="rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-sm text-primary outline-none focus:border-focus-blue"
                  />
                </label>
                <label className="grid gap-1 text-xs text-muted">
                  Password
                  <input
                    type="password"
                    required
                    value={manualPassword}
                    onChange={(event) => setManualPassword(event.target.value)}
                    autoComplete="new-password"
                    className="rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-sm text-primary outline-none focus:border-focus-blue"
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <SecondaryButton type="button" onClick={cancelManualCredential} disabled={busy}>
                    Cancel
                  </SecondaryButton>
                  <SecondaryButton type="submit" disabled={busy || !manualOrigin || !manualPassword}>
                    {busy && <Spinner size={13} />}
                    {busy ? 'Saving' : 'Save'}
                  </SecondaryButton>
                </div>
              </form>
            )}

            <div className="overflow-hidden rounded-xl border border-subtle bg-surface-1">
              {filteredCredentials.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-muted">
                  {credentials.length === 0 ? 'No saved passwords' : 'No matching passwords'}
                </div>
              ) : filteredCredentials.map((credential) => (
                <div
                  key={credential.id}
                  className="flex items-center gap-3 border-b border-subtle px-4 py-3 last:border-b-0"
                >
                  <Globe size={18} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {new URL(credential.origin).hostname}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {credential.username || 'No username'}
                    </div>
                  </div>
                  <button
                    onClick={() => void removeCredential(credential.id)}
                    className="rounded-lg p-2 text-muted hover:bg-hover hover:text-primary"
                    aria-label={`Remove password for ${credential.origin}`}
                  >
                    <Trash size={15} />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-5">
            <section className="rounded-xl border border-subtle bg-surface-1 p-5">
              <h2 className="mb-1 text-sm font-medium">Import passwords</h2>
              <p className="mb-4 text-xs text-muted">
                Passwords are saved with the workspace, for every device connected to it.
              </p>
              {!credentialState ? (
                <LoadingState label="Looking for Chrome" size={13} className="justify-start text-xs" />
              ) : !bridge ? (
                <span className="text-xs text-muted">Importing from Chrome is not available on this device</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {profiles.length > 0 && (
                    <>
                      <Select
                        value={selectedProfile}
                        onChange={setSelectedProfile}
                        options={profiles.map((profile) => ({
                          value: profile.id,
                          label: profile.profileName,
                        }))}
                      />
                      <SecondaryButton onClick={() => void importProfile()} disabled={busy}>
                        Import profile
                      </SecondaryButton>
                    </>
                  )}
                  <SecondaryButton onClick={() => void importFile()} disabled={busy}>
                    {busy && <Spinner size={13} />}
                    {busy ? 'Importing' : 'Choose Chrome export…'}
                  </SecondaryButton>
                </div>
              )}
            </section>

            <section className="flex items-center justify-between rounded-xl border border-subtle bg-surface-1 p-5">
              <div>
                <h2 className="text-sm font-medium">Delete saved passwords</h2>
                <p className="mt-1 text-xs text-muted">{credentials.length} saved in this workspace</p>
              </div>
              <SecondaryButton onClick={() => void removeAll()} disabled={credentials.length === 0}>
                Delete all
              </SecondaryButton>
            </section>
          </div>
        )}

        {message && <div className="mt-4 text-xs text-muted">{message}</div>}
      </div>
    </div>
  )
}
