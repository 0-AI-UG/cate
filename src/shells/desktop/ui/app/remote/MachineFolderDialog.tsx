// "Open a workspace" on a machine this device runs commands on (SSH, WSL):
// check (and, the first time, install) the runtime there, shown on its own,
// then pick or create the folder and open it as a workspace. Its connection runs the machine's
// bridge, which starts the runtime whenever nothing answers.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, Folder, FolderPlus, Server } from 'lucide-react'
import { LoadingState, Modal, btn, inputCls, Spinner } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { machineKey, machineLabel, type Machine, type MachineSetup, type RuntimeInstallProgress, type SshDirListing } from '@runtime/daemon/contract'
import { clientApp } from '../app'
import { selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { InstallProgressView, useInstallProgress } from '../workspace/installProgress'
import { crumbsOf, joinPath, parentPath } from './paths'

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
  /** A folder of the listing, clicked once: it fills the path, so Open opens it. */
  const [selected, setSelected] = useState<string | null>(null)
  const [home, setHome] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const install = useInstallProgress(step === 'checking' ? machineKey(machine) : null)
  // Set on every mount: StrictMode unmounts and remounts once in dev.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
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
      setSelected(null)
      setPathInput(next.path)
      return next
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not list the folder.'))
      return null
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [machine, setup])

  // Each run owns its check: its cleanup drops what it reports and stops what
  // still runs on the machine (an install can take minutes), so a run
  // cancelled by StrictMode or a close never reaches the dialog.
  useEffect(() => {
    let ignore = false
    setStep('checking')
    setError(null)
    void (async () => {
      try {
        const status = await setup.ensureRuntime(machine)
        if (ignore) return
        setHome(status.home)
        setStep('browse')
        const { onReady, lastPath } = ready.current
        onReady?.()
        // A folder that is gone since falls back to the home folder.
        if (!(lastPath && await open(lastPath)) && !ignore) await open(status.home)
      } catch (err) {
        if (!ignore) setError(errorMessage(err, 'Could not set up the machine.'))
      }
    })()
    return () => {
      ignore = true
      void setup.cancel(machine).catch(() => {})
    }
  }, [machine, open, setup, attempt])

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
    // The selected or typed folder (a typed one counts even without Enter).
    const target = listing && pathInput === listing.path ? listing : await open(pathInput)
    if (!target || !mounted.current) return
    setStep('opening')
    try {
      const entry = await clientApp().workspaces.addMachine(machine, target.path)
      onOpened?.(target.path)
      onClose()
      useUIStore.getState().closeOverlay()
      useUIStore.getState().setOpenDialogOpen(false)
      await selectWorkspace(entry.id)
    } catch (err) {
      if (!mounted.current) return
      setError(errorMessage(err, 'Could not open the folder.'))
      setStep('browse')
    }
  }

  const busy = step !== 'browse' || loading
  const up = listing ? parentPath(listing.path) : null

  return (
    <Modal
      onClose={onClose}
      width={560}
      icon={<Server size={16} />}
      title={`Open a workspace on ${machineLabel(machine)}`}
      dismissable={step !== 'opening'}
      // Above Settings (z-[100001]), which can open it too.
      zClassName="z-[100002]"
      bodyClassName="min-h-0 flex-1 flex flex-col"
    >
      {step === 'checking' ? (
        <MachineSetupView
          where={machineLabel(machine)}
          install={install}
          error={error}
          onCancel={onClose}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4 min-h-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={btn.ghost}
              aria-label="Up one folder"
              disabled={busy || !listing || up === listing.path}
              onClick={() => up && void open(up)}
            >
              <ArrowUp size={14} />
            </button>
            <nav aria-label="Folder" className="no-scrollbar min-w-0 flex-1 flex items-center gap-0.5 overflow-x-auto text-[12px]">
              {listing && crumbsOf(listing.path).map((crumb, index, all) => (
                <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                  {index > 1 && <span className="text-muted">/</span>}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void open(crumb.path)}
                    className={`rounded px-1.5 py-0.5 hover:bg-hover ${index === all.length - 1 ? 'text-primary font-medium' : 'text-secondary'}`}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
            <button type="button" className={btn.ghost} disabled={busy || !listing} onClick={() => { setError(null); setNewFolder('') }}>
              <FolderPlus size={14} />
              New Folder
            </button>
          </div>

          <div role="listbox" aria-label="Folders" className="h-64 overflow-auto rounded-md border border-subtle bg-surface-0 p-1">
            {newFolder !== null && (
              <form
                className="flex items-center gap-2 px-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  void createFolder()
                }}
              >
                <Folder size={14} className="shrink-0 text-muted" />
                <input
                  autoFocus
                  aria-label="New folder name"
                  className={inputCls}
                  value={newFolder}
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return
                    e.preventDefault()
                    e.stopPropagation()
                    setNewFolder(null)
                  }}
                  disabled={busy}
                />
              </form>
            )}
            {loading && <LoadingState size={12} className="justify-start px-2 py-1 text-[12px]" />}
            {listing && !loading && listing.dirs.length === 0 && <div className="px-2 py-1 text-[12px] text-muted">No folders here.</div>}
            {listing && !loading && listing.dirs.map((name) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={selected === name}
                disabled={busy}
                onClick={() => {
                  setSelected(name)
                  setPathInput(joinPath(listing.path, name))
                }}
                onDoubleClick={() => void open(joinPath(listing.path, name))}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] text-primary ${selected === name ? 'bg-surface-4' : 'hover:bg-hover'}`}
              >
                <Folder size={14} className="shrink-0 text-secondary" />
                <span className="truncate">{name}</span>
              </button>
            ))}
          </div>

          {error && <div role="alert" className="text-[12px] text-error">{error}</div>}

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void open(pathInput)
            }}
          >
            <input
              className={`${inputCls} font-mono`}
              value={pathInput}
              onChange={(e) => { setPathInput(e.target.value); setSelected(null) }}
              placeholder={home}
              aria-label="Folder path"
              spellCheck={false}
              disabled={busy}
            />
            <button type="button" className={btn.secondary} onClick={onClose} disabled={step === 'opening'}>Cancel</button>
            <button type="button" className={btn.primary} onClick={() => void openWorkspace()} disabled={busy || !pathInput.trim()}>
              {step === 'opening' && <Spinner size={13} />}
              Open
            </button>
          </form>
        </div>
      )}
    </Modal>
  )
}

/** Before the folders: reaching the machine and, the first time, installing
 *  the runtime there, or why that failed. */
function MachineSetupView({ where, install, error, onCancel, onRetry }: {
  where: string
  install: RuntimeInstallProgress | null
  error: string | null
  onCancel: () => void
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex min-h-[288px] flex-col items-center justify-center gap-3 px-6 text-center">
        {error ? (
          <>
            <AlertCircle size={20} className="text-error" />
            <span className="text-[14px] font-medium text-primary">Could not set up {where}</span>
            <span role="alert" className="max-w-[420px] break-words text-[12px] leading-relaxed text-secondary">{error}</span>
          </>
        ) : install ? (
          <>
            <span className="text-[14px] font-medium text-primary">Setting up {where}</span>
            <span className="text-[12px] text-secondary">Cate installs its runtime there once. This can take a few minutes.</span>
            <div className="mt-2 w-full max-w-[360px] text-left"><InstallProgressView progress={install} where={where} /></div>
          </>
        ) : (
          <>
            <Spinner size={16} />
            <span role="status" className="text-[14px] font-medium text-primary">Connecting to {where}</span>
            <span className="text-[12px] text-secondary">Checking for the Cate runtime there.</span>
          </>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onCancel}>Cancel</button>
        {error && <button type="button" className={btn.primary} onClick={onRetry}>Try again</button>}
      </div>
    </div>
  )
}
