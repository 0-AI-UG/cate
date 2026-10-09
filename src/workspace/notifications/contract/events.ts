// Notification events (architecture 10.5): what the runtime tells every
// client of the workspace. Agents, the terminal and `cate.ui.notify` publish;
// each client decides whether to show one from its settings and focus.

/** An agent that needs the person, or a `cate.ui.notify` message (which may
 *  name no panel). */
export type NotificationEvent =
  | {
      kind: 'agent.needsInput' | 'agent.needsPermission'
      panelId: string
      title: string
      body: string
    }
  | {
      kind: 'cate.ui.notify'
      panelId?: string
      title: string
      body: string
      level?: 'info' | 'warning' | 'error'
    }
