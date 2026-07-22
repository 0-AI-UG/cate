import type {
  CodingCreateOptions,
  CodingImageAttachment,
} from '../../shared/types'

/** Renderer-side client for the common agent session lifecycle. */
export const codingClient = {
  create(options: CodingCreateOptions) {
    return window.electronAPI.agentCreate(options)
  },
  prompt(panelId: string, text: string, images?: CodingImageAttachment[]) {
    return window.electronAPI.agentPrompt(panelId, text, images)
  },
  steer(panelId: string, text: string, images?: CodingImageAttachment[]) {
    return window.electronAPI.agentSteer(panelId, text, images)
  },
  interrupt(panelId: string) {
    return window.electronAPI.agentInterrupt(panelId)
  },
  dispose(panelId: string) {
    return window.electronAPI.agentDispose(panelId)
  },
} as const
