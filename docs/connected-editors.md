# Connected text editors

An editor reachable through a terminal or chat panel's outgoing relations
shares a normal working file with the agent. Agents read and write it with
their usual filesystem tools; the `cate` CLI does not provide editor content
commands.

Everything below runs in the workspace's runtime (architecture 9.7):
`createConnectedEditors` in `src/workspace/relations/runtime/` decides which
editors are shared (from the document's relations and each panel type's
`relation` role) and tells their sessions; the editor session
(`src/panels/editor/session.ts`) does the saving. It applies to every client
of the workspace at once.

- An untitled editor gets a persistent `.cate/tmp/<document-id>.md` file in
  its checkout. Its title stays unchanged and the editor stays in source mode.
- An opened text file keeps its existing path.
- The "Shared with agent" indicator means edits autosave after 300 ms.
  Disconnecting the editor stops autosave. The relation's Next/Always/Off
  setting controls prompt context, independently of editor synchronization.
- Submitting a prompt from a terminal or chat panel flushes the connected
  editors first. A conflict or failed save blocks submission (the flush fails
  with `conflict`) until the editor is resolved and the user retries.
- External file writes reload a clean buffer. Changes made while the buffer
  has unsaved edits mark it as conflicting; neither version is discarded, and
  any viewer resolves it in the editor view.
- Save As (also Cmd/Ctrl+S for a draft) chooses a normal destination and moves
  the panel's buffer to it. The old draft remains as recovery data; it is not
  automatically deleted. An agent already using the old path is not
  redirected. Later relation context names the new path.
- Drafts are ordinary files in the checkout, so they survive a runtime
  restart; each open buffer watches its file's directory, hidden or not.
- Image, PDF, and DOCX previews are never shared or autosaved.
- Nothing is shared while the workspace setting `panelRelationsEnabled` is off.

This does not execute relations, send tasks automatically, or coordinate agent
workflows. Agents choose when to act and when to use `cate agent send`.
