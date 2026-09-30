import { sendOsNotification } from '../notifications/osNotificationSend'
import type { NotificationAction } from '../../../shared/types'

/** The one "agent needs you" OS notification, shared by every agent surface:
 *  terminal CLI agents (agentScreenDetector) and T3 panels (AgentSession).
 *  `permission` switches to the needs-permission variant and carries what the
 *  agent is blocked on. Callers gate on a real state transition. */
export function notifyAgentNeedsAttention(options: {
  agentName: string | null
  action: NotificationAction
  permission?: string
}): void {
  const displayName = options.agentName ?? 'Agent'
  sendOsNotification({
    title: options.permission ? `${displayName} needs permission` : `${displayName} needs input`,
    body: options.permission ?? `${displayName} is waiting for your response.`,
    action: options.action,
  })
}
