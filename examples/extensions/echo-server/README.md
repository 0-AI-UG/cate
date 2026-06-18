# echo-server — server-backed extension example

A minimal, dependency-free server-backed Cate extension. Unlike a frontend-only
extension (which ships static assets), this one ships its own Node HTTP server.
Cate spawns it on the workspace's runtime host (local OR remote), allocates a
free loopback port, injects it as `PORT`, probes `/health`, and only then shows
the panel. All panel traffic is reverse-proxied to the server over a tunnel.

What it proves:

- **Server spawn + ready probe** — the panel only loads after `/health` returns 200.
- **HTTP tunneling** — `GET /` is served by `server.js`, not from disk.
- **WebSocket tunneling** — the page opens a `ws://` back to `/ws` and echoes a message.
- **Token injection** — every non-`/health` request requires
  `Authorization: Bearer <CATE_TOKEN>`. The proxy injects it; the webview never
  holds it. Requests without it get a 401.

## Try it

1. Cate → Settings → Extensions → Add sideload folder → pick this directory.
2. Enable **Echo Server**.
3. Open its panel. You should see "Served by the extension's own HTTP server" and
   "WebSocket open" with an `echo: ping from page` line.

## Environment Cate injects

- `PORT` — the allocated loopback port (bind here).
- `CATE_TOKEN` — the bearer the proxy injects on every proxied request.
- `WORKSPACE_ROOT` — the workspace's runtime-absolute root path.
