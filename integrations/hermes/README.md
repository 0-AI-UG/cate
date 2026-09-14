# Hermes Agent integration

Cate can restore each terminal to the exact Hermes conversation it previously hosted. The integration uses a small Hermes plugin installed into one Hermes profile. The plugin is inert outside Cate terminals.

## Install

From the Cate checkout:

```bash
bun run hermes:integration -- install --profile work
```

Restart any running Hermes CLI after installation so it loads the plugin.

Check status:

```bash
bun run hermes:integration -- status --profile work
```

Remove it:

```bash
bun run hermes:integration -- uninstall --profile work
```

`--profile` is required. Use `--profile default` explicitly for Hermes's default profile; arbitrary custom `HERMES_HOME` layouts are not eligible for automatic restore. The installer removes any ambient `HERMES_HOME` override from its Hermes subprocesses so the selected profile always resolves under Hermes's canonical profile root.

## How it works

1. Cate places a loopback endpoint, per-terminal bearer token, and terminal ID in every PTY environment.
2. The `cate-agent-state` plugin reports root CLI lifecycle hooks to that endpoint.
3. Cate saves the Hermes session ID and canonical profile with the terminal panel.
4. A restored panel starts a fresh shell and runs `hermes --profile <profile> chat --resume <session-id>`.

Exact session IDs are used instead of bare `--continue`, so two terminals in the same directory cannot accidentally converge on the newest conversation.

## Safety and limits

- The endpoint must be loopback HTTP and is authenticated with Cate's per-terminal token.
- Processes launched inside a Cate terminal inherit that token and share the terminal's trust boundary; the token isolates terminals, not processes within one terminal.
- The plugin ignores subagent, cron, and gateway sessions.
- Hook delivery is synchronous but best-effort, with a 750 ms timeout; failures never abort the Hermes session.
- Cate accepts no command string from the plugin; session and profile values must be shell-safe tokens.
- Install separately for every named Hermes profile used inside Cate.
- Custom `HERMES_HOME` layouts report Hermes profile `custom` and are intentionally not stamped for automatic restore.
