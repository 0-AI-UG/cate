// IPC for setting up and browsing machines this device runs commands on
// (SSH, WSL), and how far the runtime installs are. Main checks every machine and path itself: the command line is
// built from validated fields only (runtime/daemon/contract `machineCommand`).
// SSH prompts (passwords, one-time codes) go to the last focused main
// window, which asks the person and answers.

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { isMachine, machineLabel, type Machine } from '@runtime/daemon/contract'
import type { MachineProvisioner } from '@runtime/daemon/desktop'
import { DESKTOP_CHANNELS as C, type MachinePrompt } from '../contract'
import { handle, listen } from './ipc'
import type { InstallProgressHub } from './installProgress'
import type { WindowRegistry } from './windowRegistry'

/** A prompt nobody answers in this long is cancelled. */
const PROMPT_MS = 3 * 60_000

function machine(value: unknown): Machine {
  if (!isMachine(value)) throw new Error('invalid machine')
  return value
}

function remotePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('invalid path')
  return value
}

export function registerMachineIpc(machines: MachineProvisioner, installs: InstallProgressHub, prompts: MachinePrompts): void {
  handle(C.installs, () => installs.snapshot())
  handle(C.machineEnsureRuntime, (_event, m: unknown) => machines.ensureRuntime(machine(m)))
  handle(C.machineListDir, (_event, m: unknown, path: unknown) => machines.listDir(machine(m), remotePath(path)))
  handle(C.machineMkdir, (_event, m: unknown, path: unknown) => machines.mkdir(machine(m), remotePath(path)))
  handle(C.machineWslDistros, () => machines.wslDistros())
  handle(C.machineSshHosts, () => machines.sshHosts())
  handle(C.machineCancel, (_event, m: unknown) => {
    const target = machine(m)
    prompts.cancelFor(machineLabel(target))
    return machines.cancel(target)
  })
}

export interface MachinePrompts {
  /** Asks in a main window; null when nobody answers, or once `signal`
   *  aborts (ssh stopped waiting), and the window drops the question. */
  ask(request: { machine: string; prompt: string }, signal?: AbortSignal): Promise<string | null>
  /** Withdraws the questions for a machine (the person cancelled what asked). */
  cancelFor(machine: string): void
}

/** Asks for what ssh prompts in a main window. */
export function createMachinePrompts(registry: WindowRegistry<BrowserWindow>): MachinePrompts {
  const pending = new Map<string, { contents: number; machine: string; resolve: (answer: string | null) => void }>()
  listen(C.machinePromptAnswer, (event, id: unknown, answer: unknown) => {
    const waiting = typeof id === 'string' ? pending.get(id) : undefined
    // Only the window that was asked answers.
    if (!waiting || waiting.contents !== event.sender.id) return
    pending.delete(id as string)
    waiting.resolve(typeof answer === 'string' ? answer : null)
  })
  return {
    ask(request, signal) {
      const target = registry.activeMain()
      if (!target || target.win.isDestroyed() || signal?.aborted) return Promise.resolve(null)
      const id = randomUUID()
      const contents = target.win.webContents
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(null), PROMPT_MS)
        const onDestroyed = () => finish(null)
        const onAbort = () => finish(null)
        let done = false
        const finish = (answer: string | null) => {
          if (done) return
          done = true
          clearTimeout(timer)
          pending.delete(id)
          contents.removeListener('destroyed', onDestroyed)
          signal?.removeEventListener('abort', onAbort)
          // Not answered from the window: it drops the question.
          if (answer === null && !contents.isDestroyed()) contents.send(C.machinePromptCancel, id)
          resolve(answer)
        }
        pending.set(id, { contents: contents.id, machine: request.machine, resolve: finish })
        contents.once('destroyed', onDestroyed)
        signal?.addEventListener('abort', onAbort, { once: true })
        const prompt: MachinePrompt = { id, machine: request.machine, prompt: request.prompt }
        contents.send(C.machinePrompt, prompt)
        if (!target.win.isFocused()) target.win.focus()
      })
    },
    cancelFor(machine) {
      for (const waiting of [...pending.values()]) if (waiting.machine === machine) waiting.resolve(null)
    },
  }
}
