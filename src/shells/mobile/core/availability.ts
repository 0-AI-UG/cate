// What happens to a workspace when the person closes Cate, for the app: the
// `keepRunningWhile` close choice (runtime/daemon contract) as the desktop's
// Availability page offers it, with the machine it runs on, and the core API
// that sets it.

import { eachConnection } from '@client/connections'
import { closeChoiceOf, closeChoiceTriggers } from '@runtime/daemon/contract'
import type { MobileCoreMethods, MobileWhenClosed } from '../contract'
import { wordsFor } from './actions'
import type { MobileClient } from './boot'
import type { MobileWorkspaceSettings } from './workspaceSettings'

export interface MobileAvailability {
  /** Null while not connected. */
  whenClosed(workspaceId: string): MobileWhenClosed | null
  subscribe(listener: () => void): () => void
}

interface Machine {
  name: string | null
  sleeps: boolean
}

export function createMobileAvailability(client: Pick<MobileClient, 'connections'>, settings: MobileWorkspaceSettings): MobileAvailability {
  const machines = new Map<string, Machine>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }

  // The machine does not change while a connection lives: asked once it is
  // connected, again after a failed ask.
  eachConnection(client.connections, (connection) => {
    const { workspaceId, runtime } = connection
    let asked = false
    const ask = () => {
      if (asked || connection.getState().kind !== 'connected') return
      asked = true
      runtime.runtime.info().then(
        (info) => {
          machines.set(workspaceId, { name: info.machineName ?? null, sleeps: info.machineSleeps ?? true })
          changed()
        },
        () => { asked = false },
      )
    }
    const off = connection.subscribe(ask)
    ask()
    return () => {
      off()
      machines.delete(workspaceId)
      changed()
    }
  })

  return {
    whenClosed(workspaceId) {
      const mirror = settings.of(workspaceId)
      if (!mirror) return null
      const triggers = mirror.get('keepRunningWhile')
      const machine = machines.get(workspaceId)
      return {
        choice: closeChoiceOf(triggers),
        commands: triggers.includes('commands'),
        machine: machine?.name ?? null,
        // Unknown: worded for a machine that sleeps, as the desktop does.
        machineSleeps: machine?.sleeps ?? true,
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      const offSettings = settings.subscribe(listener)
      return () => {
        listeners.delete(listener)
        offSettings()
      }
    },
  }
}

export function createAvailabilityHandlers(settings: MobileWorkspaceSettings): {
  'runtime.setWhenClosed': (params: MobileCoreMethods['runtime.setWhenClosed']['params']) => Promise<MobileCoreMethods['runtime.setWhenClosed']['result']>
} {
  return {
    async 'runtime.setWhenClosed'({ workspaceId, choice, commands }) {
      const mirror = settings.of(workspaceId)
      if (!mirror) return { ok: false, message: 'The workspace is not connected.' }
      try {
        await mirror.set('keepRunningWhile', closeChoiceTriggers(choice, commands))
        return { ok: true }
      } catch (error) {
        return { ok: false, message: wordsFor(error) }
      }
    },
  }
}
