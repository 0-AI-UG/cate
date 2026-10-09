// "Open a folder" on a machine this device runs commands on (SSH, WSL):
// check (and, the first time, install) the runtime there, pick or create the
// folder, then open it as a workspace. Its connection runs the machine's
// bridge, which starts the runtime whenever nothing answers.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, FolderPlus, Server } from 'lucide-react'
import { Modal, btn, inputCls, Spinner } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { machineLabel, type Machine, type MachineSetup, type SshDirListing } from '@runtime/daemon/contract'
import { clientApp } from '../app'
import { selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { joinPath, parentPath } from './paths'

type Step = 'checking' | 'browse' | 'opening'

export function MachineFolderDialog({ machine, setup, lastPath, onReady, onOpened, onClose }: {
  machine: Machine
  setup: MachineSetup
  /** The folder opened last on this machine, listed first. */
  lastPath?: string
  /** The machine answered and has the runtime. */
  onReady?: () => void
  onOpened?: (path: string) => void
  onClose: () => void
}): JSX.Element {
  const [step, setStep] = useState<Step>('checking')
  const [listing, setListing] = useState<SshDirListing | null>(null)
  const [home, setHome] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installedNow, setInstalledNow] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  // Closing stops what still runs there (an install can take minutes).
  useEffect(() => () => { void setup.cancel(machine).catch(() => {}) }, [machine, setup])
  // Read when the check ends, so a new callback does not check again.
  const ready = useRef({ onReady, lastPath })
  ready.current = { onReady, lastPath }

  /** Lists `path`; null when it cannot. */
  const open = useCallback(async (path: string): Promise<SshDirListing | null> => {
    setLoading(true)
    setError(null)
    try {
      const next = await setup.listDir(machine, path)
      if (!mounted.current) return null
      setListing(next)
      setPathInput(next.path)
      return next
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not list the folder.'))
      return null
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [machine, setup])

  const check = useCallback(async () => {
    setStep('checking')
    setError(null)
    try {
      const status = await setup.ensureRuntime(machine)
      if (!mounted.current) return
      setInstalledNow(status.installedNow)
      setHome(status.home)
      setStep('browse')
      const { onReady, lastPath } = ready.current
      onReady?.()
      // A folder that is gone since falls back to the home folder.
      if (!(lastPath && await open(lastPath))) await open(status.home)
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not set up the machine.'))
    }
  }, [machine, open, setup])

  useEffect(() => { void check() }, [check])

  const createFolder = async () => {
    if (!listing || !newFolder?.trim()) return
    setLoading(true)
    setError(null)
    try {
      const created = await setup.mkdir(machine, joinPath(listing.path, newFolder.trim()))
      setNewFolder(null)
      await open(created)
    } catch (err) {
      setError(errorMessage(err, 'Could not create the folder.'))
      setLoading(false)
    }
  }

  const openWorkspace = async () => {
    // A typed path counts even when Enter was not pressed.
    const target = listing && pathInput === listing.path ? listing : await open(pathInput)
    if (!target || !mounted.current) return
    setStep('opening')
    try {
      const entry = await clientApp().workspaces.addMachine(machine, target.path)
      onOpened?.(target.path)
      onClose()
      useUIStore.getState().closeOverlay()
      await selectWorkspace(entry.id)
    } catch (err) {
      if (!mounted.current) return
      setError(errorMessage(err, 'Could not open the folder.'))
      setStep('browse')
    }
  }

  const busy = step !== 'browse' || loading

  return (
    <Modal
      onClose={onClose}
      width={520}
      icon={<Server size={16} />}
      title="Open a folder"
      dismissable={step !== 'opening'}
      bodyClassName="px-5 py-4"
    >
      <p className="text-xs text-muted font-mono truncate">{machineLabel(machine)}</p>

      {step === 'checking' && !error && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-secondary">
          <Spinner size={13} />
          Checking the Cate runtime there. The first time, Cate downloads and installs it, which can take a few minutes.
        </div>
      )}

      {step !== 'checking' && (
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
              disabled={busy || !listing || listing.path === '/'}
              onClick={() => listing && void open(parentPath(listing.path))}
            >
              <ArrowUp size={13} />
            </button>
            <input
              className={`${inputCls} font-mono`}
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder={home}
              aria-label="Folder path"
              spellCheck={false}
              disabled={busy}
            />
          </form>
          {listing && (
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
          )}
          {listing && (newFolder !== null ? (
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
          ))}
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose} disabled={step === 'opening'}>
          Cancel
        </button>
        {step === 'checking' && error ? (
          <button type="button" className={btn.primary} onClick={() => void check()}>Try again</button>
        ) : (
          <button type="button" className={btn.primary} onClick={() => void openWorkspace()} disabled={busy || !pathInput.trim()}>
            {step === 'opening' && <Spinner size={13} />}
            Open this folder
          </button>
        )}
      </div>
    </Modal>
  )
}
