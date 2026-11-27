// What the daemon's composition root needs to register the note type.

import noteDefinition from './definition'
import { NoteSession } from './session'

export { noteDefinition, NoteSession }

export function notePanel() {
  return { definition: noteDefinition, session: NoteSession }
}
