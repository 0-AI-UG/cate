# cate-nativehost socket protocol

`cate-nativehost serve` is the **server**: it creates, binds, and listens on a
UNIX-domain socket at the path given via `--socket`, then accepts exactly one
client connection. Once a client connects it streams length-prefixed messages
until the client disconnects, the process is asked to shut down (SIGTERM /
SIGINT), or the underlying `SCStream` fails.

## Framing

Every message on the wire has the same envelope:

```
[UInt32 big-endian payloadLength][UInt8 type][payload: payloadLength bytes]
```

- `payloadLength` — length of `payload` in bytes, NOT including the 4-byte
  length field or the 1-byte type field. Big-endian (network byte order).
- `type` — one byte:
  - Server → client:
    - `0x01` — JSON control message (UTF-8 encoded JSON object).
    - `0x02` — JPEG frame (raw JPEG bytes, no further wrapping).
  - Client → server (same framing, the client may send these once connected):
    - `0x10` — JSON input event (mouse/keyboard/scroll).
    - `0x11` — JSON resize command.
- `payload` — exactly `payloadLength` bytes.

There is no message-count prefix and no trailer; keep reading
`4 + 1 + payloadLength` bytes per message until EOF. The framing is identical
in both directions.

## Control messages (`type` 0x01)

All control messages are a single JSON object with a `"t"` field naming the
message kind:

| `t`        | Fields                                                          | When |
|------------|------------------------------------------------------------------|------|
| `ready`    | `displayId` (number), `appPid` (number)                          | Once, after the virtual display is created and the target app has been launched. |
| `placed`   | `onDisplay` (bool)                                                | Once, after AX window placement was attempted and independently confirmed via `CGWindowListCopyWindowInfo`. `onDisplay` reflects the confirmation check, not the AX call's own success/failure — placement can report AX failure and `onDisplay` can still end up `true` (or vice versa) depending on timing. |
| `status`   | `frames` (number), `complete` (number), `idle` (number), `suspended` (number) | Every ~2s while capturing. Counts are cumulative since capture start (not reset between messages). |
| `error`    | `message` (string)                                                | Any time something recoverable-but-worth-surfacing or fatal happens (e.g. capture failed to start, SCStream stopped with an error). An `error` message does not by itself mean the process is exiting — check whether frames/status keep arriving afterward. |

In addition to those, the capture path also emits `{"t":"capture", ...}` once
capture starts, reporting the chosen mode (`window` or `display-fallback`) and
the frame pixel size + backing `scale`.

Unknown `t` values should be ignored by forward-compatible clients rather
than treated as a protocol error.

## Inbound messages (client → server)

Sent by the client after connecting, using the same framing.

### Input events (`type` 0x10)

A single JSON object. Pointer positions are **normalized** (`nx`, `ny` in
0…1) over the captured window content, so they're independent of window/panel
pixel size; the server maps them to global display points via the window's
live frame. `k` names the event kind:

| `k`  | Fields | Meaning |
|------|--------|---------|
| `m`  | `a` (`down`/`up`/`move`/`drag`), `nx`, `ny`, `b` (0 left, 1 right), `clicks`, `cmd`/`shift`/`opt`/`ctrl` | Mouse button / motion. |
| `s`  | `nx`, `ny`, `dx`, `dy` | Scroll (pixel deltas; +y = up). |
| `k`  | `a` (`down`/`up`), `code` (macOS virtual key code) or `text` (unicode), `cmd`/`shift`/`opt`/`ctrl` | Keyboard. |

Events are injected via `CGEvent` posted to the app's PID, so they land even
though the window is on a headless display and never frontmost.

### Resize (`type` 0x11)

`{ "w": <points>, "h": <points> }` — resize the captured app window to this
logical size (pinned to the virtual display origin) and reconfigure capture to
match, so the frame fills the panel at native resolution with no letterboxing.

## Frame messages (`type` 0x02)

Raw JPEG bytes for one captured frame of the virtual display (whatever is
currently on it — the target app if placement succeeded, otherwise an empty
desktop). Decode directly as a JPEG image; there is no additional header.
Frames are only sent for `SCStreamFrameInfo.status` values of `.complete` or
`.idle` (frames with `.blank`/`.suspended`/`.started`/`.stopped` status carry
no new pixel data and are skipped, though they still count toward the
`status` control message's tallies).

## Lifecycle

- On SIGTERM/SIGINT, or when the client closes its end of the socket, the
  server stops the `SCStream`, terminates the launched app, releases the
  virtual display, unlinks the socket file, and exits `0`.
- The server only ever accepts one client. If you need to reconnect, start a
  new `cate-nativehost serve` process against a new socket path.

## Reference TypeScript decoder

```ts
import * as net from "node:net";

type ControlMessage =
  | { t: "ready"; displayId: number; appPid: number }
  | { t: "placed"; onDisplay: boolean }
  | { t: "status"; frames: number; complete: number; idle: number; suspended: number }
  | { t: "error"; message: string };

function decodeFrames(
  socket: net.Socket,
  onControl: (msg: ControlMessage) => void,
  onJpegFrame: (jpeg: Buffer) => void
) {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (buffer.length < 5) return; // need length(4) + type(1) at minimum

      const payloadLength = buffer.readUInt32BE(0);
      const type = buffer.readUInt8(4);
      const totalLength = 5 + payloadLength;
      if (buffer.length < totalLength) return; // wait for more data

      const payload = buffer.subarray(5, totalLength);
      buffer = buffer.subarray(totalLength);

      if (type === 0x01) {
        onControl(JSON.parse(payload.toString("utf8")) as ControlMessage);
      } else if (type === 0x02) {
        onJpegFrame(Buffer.from(payload));
      }
      // unknown type: ignore payload, keep parsing (forward-compatible)
    }
  });
}
```
