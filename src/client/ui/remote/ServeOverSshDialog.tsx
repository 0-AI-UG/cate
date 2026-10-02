// "Serve a folder" on a machine reached over SSH: check (and, the first time,
// install) the runtime, pick or create the folder, then serve it, pair and
// open the workspace. One flow for the person; `serve.ts` keeps the steps.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, FolderPlus, Server } from 'lucide-react'
import { Modal, Spinner, btn, errorMessage, inputCls } from '@kernel/ui'
import { setClientSetting, useClientSetting } from '@kernel/settings/ui'
import { formatSshTarget, type SshDirListing, type SshMachine, type SshSetup } from '@runtime/daemon/contract'
import { clientApp } from '../app'
import { selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { joinPath, parentPath, serveOverSsh, withMachine } from './serve'

type Step = 'checking' | 'browse' | 'serving'

export function ServeOverSshDialog({ machine, ssh, onClose }: { machine: SshMachine; ssh: SshSetup; onClose: () => void }): JSX.Element {
  const app = clientApp()
  const machines = useClientSetting('sshMachines')
  const [step, setStep] = useState<Step>('checking')
  const [listing, setListing] = useState<SshDirListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installedNow, setInstalledNow] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const open = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const next = await ssh.listDir(machine.target, path)
      if (!mounted.current) return
      setListing(next)
      setPathInput(next.path)
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not list the folder.'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [machine.target, ssh])

  const check = useCallback(async () => {
    setStep('checking')
    setError(null)
    try {
      const status = await ssh.ensureRuntime(machine.target)
      if (!mounted.current) return
      setInstalledNow(status.installedNow)
      setStep('browse')
      await open(machine.lastPath ?? status.home)
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not set up the machine.'))
    }
  }, [machine.lastPath, machine.target, open, ssh])

  useEffect(() => { void check() }, [check])

  const createFolder = async () => {
    if (!listing || !newFolder?.trim()) return
    setLoading(true)
    setError(null)
    try {
      const created = await ssh.mkdir(machine.target, joinPath(listing.path, newFolder.trim()))
      setNewFolder(null)
      await open(created)
    } catch (err) {
      setError(errorMessage(err, 'Could not create the folder.'))
      setLoading(false)
    }
  }

  const serve = async () => {
    if (!listing || !app.pair) return
    setStep('serving')
    setError(null)
    try {
      const entry = await serveOverSsh(machine, listing.path, { ssh, pair: app.pair, workspaces: app.workspaces })
      setClientSetting('sshMachines', withMachine(machines, { ...machine, lastPath: listing.path }))
      onClose()
      useUIStore.getState().closeOverlay()
      await selectWorkspace(entry.id)
    } catch (err) {
      if (!mounted.current) return
      setError(errorMessage(err, 'Could not serve the folder.'))
      setStep('browse')
    }
  }

  const busy = step !== 'browse' || loading

  return (
    <Modal
      onClose={onClose}
      width={520}
      icon={<Server size={16} />}
      title="Serve a folder"
      dismissable={step !== 'serving'}
      bodyClassName="px-5 py-4"
    >
      <p className="text-xs text-muted font-mono truncate">{formatSshTarget(machine.target)}</p>

      {step === 'checking' && !error && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-secondary">
          <Spinner size={13} />
          Checking the Cate runtime there. The first time, Cate installs it, which can take a minute.
        </div>
      )}

      {step !== 'checking' && listing && (
        <div className="mt-3 flex flex-col gap-2">
          {installedNow && <p className="text-xs text-secondary">Installed the Cate runtime.</p>}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void open(pathInput)
            }}
          >
            <button
              type="button"
              className={btn.secondary}
              aria-label="Parent folder"
              disabled={busy || listing.path === '/'}
              onClick={() => void open(parentPath(listing.path))}
            >
              <ArrowUp size={13} />
            </button>
            <input
              className={`${inputCls} font-mono`}
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              aria-label="Folder path"
              spellCheck={false}
              disabled={busy}
            />
          </form>
          <ul
            className="h-56 overflow-y-auto rounded-md border border-subtle bg-surface-0 py-1"
            aria-label="Folders"
          >
            {listing.dirs.length === 0 && <li className="px-3 py-1.5 text-xs text-muted">No folders here.</li>}
            {listing.dirs.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1 text-left text-[13px] text-secondary hover:bg-surface-5 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void open(joinPath(listing.path, name))}
                >
                  <Folder size={13} className="shrink-0 text-muted" />
                  <span className="truncate">{name}</span>
                </button>
              </li>
            ))}
          </ul>
          {newFolder !== null ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void createFolder()
              }}
            >
              <input
                className={inputCls}
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                placeholder="Folder name"
                aria-label="New folder name"
                autoFocus
                disabled={busy}
              />
              <button type="submit" className={btn.secondary} disabled={busy || !newFolder.trim()}>Create</button>
              <button type="button" className={btn.ghost} onClick={() => setNewFolder(null)} disabled={busy}>Cancel</button>
            </form>
          ) : (
            <button type="button" className={`${btn.ghost} self-start`} onClick={() => setNewFolder('')} disabled={busy}>
              <FolderPlus size={13} />
              New folder
            </button>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={step === 'serving'}>
          Cancel
        </button>
        {step === 'checking' && error ? (
          <button type="button" className={btn.primary} onClick={() => void check()}>Try again</button>
        ) : (
          <button type="button" className={btn.primary} onClick={() => void serve()} disabled={busy || !listing || !app.pair}>
            {step === 'serving' && <Spinner size={13} />}
            {step === 'serving' ? 'Serving' : 'Serve this folder'}
          </button>
        )}
      </div>
    </Modal>
  )
}
