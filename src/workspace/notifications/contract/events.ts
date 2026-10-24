// Notification events (architecture 10.4): what the runtime tells every
// client of the workspace. Agents and the runtime itself publish;
// each client decides whether to show one from its settings and focus.

/** An agent that needs the person, or a runtime warning (which may name no
 *  panel). */
export type NotificationEvent =
  | {
      kind: 'agent.needsInput' | 'agent.needsPermission'
      panelId: string
      title: string
      body: string
    }
  | {
      kind: 'runtime.warning'
      panelId?: string
      title: string
      body: string
    }
