import { useCallback, useEffect, useMemo, useState } from 'react'
import { Globe, Key, MagnifyingGlass, Trash } from '@phosphor-icons/react'
import type {
  BrowserCredentialProfile,
  BrowserCredentialProfilesResult,
  BrowserCredentialSuggestion,
} from '../../shared/types'
import { SecondaryButton, Select } from '../settings/SettingsComponents'

type PasswordManagerTab = 'passwords' | 'advanced'

export function BrowserPasswordManagerPage(): JSX.Element {
  const [tab, setTab] = useState<PasswordManagerTab>('passwords')
  const [query, setQuery] = useState('')
  const [credentialState, setCredentialState] = useState<BrowserCredentialProfilesResult | null>(null)
  const [credentials, setCredentials] = useState<BrowserCredentialSuggestion[]>([])
  const [selectedProfile, setSelectedProfile] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const [profiles, saved] = await Promise.all([
      window.electronAPI.browserCredentialProfiles(),
      window.electronAPI.browserCredentialList(),
    ])
    setCredentialState(profiles)
    setCredentials(saved)
    setSelectedProfile((current) =>
      profiles.profiles.some((profile) => profile.id === current)
        ? current
        : profiles.profiles[0]?.id ?? '')
  }, [])

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

  const importProfile = async () => {
    if (!selectedProfile) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.electronAPI.browserCredentialImport(selectedProfile)
      setMessage(`Imported ${result.imported} password${result.imported === 1 ? '' : 's'}.`)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Password import failed.')
    } finally {
      setBusy(false)
    }
  }

  const importFile = async () => {
    setBusy(true)
    setMessage('')
    try {
      const result = await window.electronAPI.browserCredentialImportFile()
      if (!result.canceled) {
        setMessage(
          `Imported ${result.imported} password${result.imported === 1 ? '' : 's'}. `
          + 'Delete the plaintext export file when you no longer need it.',
        )
        await load()
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Password import failed.')
    } finally {
      setBusy(false)
    }
  }

  const removeCredential = async (id: string) => {
    await window.electronAPI.browserCredentialRemove(id)
    setCredentials((current) => current.filter((credential) => credential.id !== id))
  }

  const removeAll = async () => {
    if (!window.confirm('Remove all passwords imported into Cate?')) return
    await window.electronAPI.browserCredentialClear()
    setCredentials([])
    setMessage('Saved passwords removed.')
  }

  const profiles = credentialState?.profiles ?? []

  return (
    <div className="h-full overflow-y-auto bg-surface-0 text-primary">
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
            <label className="relative mb-6 block">
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
                Passwords are encrypted with operating-system secure storage.
              </p>
              {!credentialState ? (
                <span className="text-xs text-muted">Checking…</span>
              ) : !credentialState.secureStorageAvailable ? (
                <span className="text-xs text-muted">Operating-system secure storage is unavailable</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {profiles.length > 0 && (
                    <>
                      <Select
                        value={selectedProfile}
                        onChange={setSelectedProfile}
                        options={profiles.map((profile: BrowserCredentialProfile) => ({
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
                    {busy ? 'Importing…' : 'Choose Chrome export…'}
                  </SecondaryButton>
                </div>
              )}
            </section>

            <section className="flex items-center justify-between rounded-xl border border-subtle bg-surface-1 p-5">
              <div>
                <h2 className="text-sm font-medium">Delete saved passwords</h2>
                <p className="mt-1 text-xs text-muted">{credentials.length} saved in Cate</p>
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
