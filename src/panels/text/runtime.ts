// What the daemon's composition root needs to register the text type.

import textDefinition from './definition'
import { TextSession } from './session'

export { textDefinition, TextSession }

export function textPanel() {
  return { definition: textDefinition, session: TextSession }
}
