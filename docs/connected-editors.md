# Connected text editors

An editor reachable through a terminal or T3 panel's outgoing connections shares
a normal working file with the agent. Agents read and write it with their usual
filesystem tools; the Cate CLI does not provide editor content commands.

- An untitled editor gets a persistent `.cate/drafts/<document-id>.md` file in
  its checkout. Its title stays unchanged and the editor stays in source mode.
- An opened text file keeps its existing path.
- The “Shared with agent” indicator means local edits autosave after 300 ms.
  Disconnecting the editor stops autosave. The connection's Next/Always/Off
  setting controls prompt context, independently of editor synchronization.
- Terminal input that can submit a prompt, and T3 prompt submission, flush
  pending edits before proceeding. A conflict or failed save blocks submission
  until the editor is resolved and the user retries.
- External file writes refresh a clean editor. Changes made while the user has
  pending edits raise the existing conflict UI; neither version is discarded.
- Save As (also Cmd/Ctrl+S for a draft) chooses a normal destination and updates
  the panel's file identity. The old draft remains as recovery data; it is not
  automatically deleted. An agent already using that old path is not redirected.
  Subsequent enabled connection context identifies the new path.
- Drafts survive session restoration. They have a dedicated directory watcher
  because the normal workspace watcher excludes hidden directories.
- Image, PDF, and DOCX previews are excluded from editor autosave.

This does not execute connections, send tasks automatically, or coordinate agent
workflows. Agents choose when to act and when to use `cate agent send`.
