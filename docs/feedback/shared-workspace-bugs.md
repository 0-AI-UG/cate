# Shared workspace bugs from Paul Horn feedback

Source: WhatsApp conversation with Paul Horn about testing Cate Connect shared workspaces. The list below normalizes the reported behavior while preserving the requested outcomes.

1. **Existing remote workspace blocks app startup.** On app start, the dialog for an existing remote workspace blocks use of the app; Paul reports that only Escape unblocks the sidebar. Show the status as a note in the sidebar and show the dialog only within the affected workspace, without putting a blocking dialog in front of the app.

2. **Nested workspaces fail.** Nested workspaces no longer work. Improve the user feedback when opening one, and check whether it is already open in another Cate instance. Do not mistake a different workspace or an already existing nested workspace for that case.

3. **Remote Save As file browser looks poor.** The file browser dialog used by remote Save As needs a visual and usability pass.

4. **T3 panel is laggy.** The T3 panel becomes noticeably slow in the shared workspace flow.

5. **Diff Review fails with a fatal Git error.** Opening Diff Review shows `fatal: not a git repository (or any of the parent directories): .git`.
   - Evidence: [WhatsApp screenshot, 2026-10-02 10:18](./shared-workspace/images/2026-10-02-1018-paul.jpeg)

6. **Empty sidebar has the wrong call to action.** When no workspace is shown, the sidebar says “Open project”; it should show a button to open a workspace.

7. **Canvas headers appear filled after opening many panels and splitting.** After opening many panels and splitting them, canvases get a filled header.
   - Evidence: [WhatsApp screenshot, 2026-10-02 10:22](./shared-workspace/images/2026-10-02-1022-paul.jpeg)

## Coverage direction

Use these reports to add end-to-end coverage through the full runtime and scenarios with two clients, including shared-workspace startup, nested workspace handling, remote file operations, panel responsiveness and errors, empty sidebar state, and canvas layout after repeated splits.
