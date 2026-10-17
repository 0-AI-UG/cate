// The folder dialog of the machine the window asked for (uiStore
// `machineFolder`), wherever it was asked from: the Open picker, the sidebar,
// Settings. A machine that answers is remembered, with the folder opened.

import { tryClientApp } from '../app'
import { useUIStore } from '../state/uiStore'
import { MachineFolderDialog } from './MachineFolderDialog'
import { rememberMachine, savedMachine } from './machines'

export function MachineFolderHost(): JSX.Element | null {
  const machine = useUIStore((s) => s.machineFolder)
  const setup = tryClientApp()?.machines
  if (!machine || !setup) return null
  return (
    <MachineFolderDialog
      machine={machine}
      setup={setup}
      lastPath={savedMachine(machine)?.lastPath}
      onReady={() => rememberMachine(machine)}
      onOpened={(path) => rememberMachine(machine, path)}
      onClose={() => useUIStore.getState().openMachineFolder(null)}
    />
  )
}
