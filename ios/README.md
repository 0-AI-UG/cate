# Cate for iOS

The mobile shell (architecture 15, `shells/mobile`). The app is native
SwiftUI; the client core runs headless in a hidden `WKWebView`
(`Cate/Core/Web/core.js`, built from `src/shells/mobile/core` by
`npm run build:mobile`). The bridge and the core API are
`src/shells/mobile/contract.ts`.

- `Cate/Core/`: the core's host (`CoreHost`), the bridge (`ShellBridge`),
  device storage, mDNS, and loopback routing for web views (`LoopbackPorts`).
- `Cate/App/`: the UI (iOS 26, Liquid Glass). Workspaces and joining; a
  workspace as Cate lays it out (`WorkspaceView`, `PlaceViews`): one of its
  dock's panels on screen at a time, picked in the title menu. A canvas panel
  shows a map of its panels where they sit, each a tile (its kind, title,
  where it is and its agent's state, drawn at the map's scale so it is the
  same at every zoom), with their connections
  (relations) drawn between them; UIKit pans and pinches it natively and the
  map is laid out again at the new scale when a pinch ends. Tap a card to
  zoom into its panel, long-press it to move it, drag its `+` handle onto
  another card to connect them (the meaning is picked right there), tap a
  connection's label to change its meaning or remove it; a card's `…` menu
  moves the panel to another worktree (as its screen's toolbar does). A
  card shows an agent as the desktop's tabs do (its logo and status mark);
  agents themselves live only in the Agents screen. With two or more worktrees, each one's
  cards sit on a terraced territory in its color (`Worktrees`), as on the
  desktop. Connections are made only on the map. `+` adds a
  panel to the dock, or places it on the canvas on screen: the map zooms out
  to the desktop's recommended spots (`canvas.suggest`) and a tap on one puts
  it there. A new agent goes where you are looking. Agents (`AgentsView`, each a chat:
  `AgentChatView`, a new agent starts from an empty chat whose box picks a
  terminal agent or a T3 Code model and a worktree), the workspace's own
  screen (who else is here, keep-awake and alerts, disconnecting);
  notifications (`Notifier`: banners, push registration, Reply); and one view
  per panel type: terminal (SwiftTerm), files (the shared buffer as text,
  previews, a file browser), browser and chat (`WKWebView`s in the
  workspace's data store), diff review, canvas (its map) and surface (the
  type picker).

- `Notifications/`: the notification service extension, which opens each
  push sealed for this device; `Shared/` holds the push key (a Keychain group
  both targets share) and the code that opens a push.

Signing is in `Signing.xcconfig`: the shipped app is `com.0ai.cate.ios` (its
extension `com.0ai.cate.ios.notifications`) on team `F7PH54XQ6J`, with push
(`Cate/Cate.entitlements`); pushes also need Cate Connect with that team's
APNs key (`CATE_CONNECT_APNS_*`, see the cate-connect README).

To run on your own phone with your own team (a free personal team cannot sign
push or another team's App IDs), copy `Local.xcconfig.example` to
`Local.xcconfig` (not checked in) and set your team id: the build gets its own
bundle id and `Cate/CateLocal.entitlements`, without push. Everything else
works, banners while the app is open included.

## Build

```bash
brew install xcodegen
cd ios
xcodegen generate          # writes Cate.xcodeproj (not checked in)
open Cate.xcodeproj
```

From the command line (if `xcode-select` points at the Command Line Tools,
prefix with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`):

```bash
xcodebuild -project Cate.xcodeproj -scheme Cate -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
  CODE_SIGN_IDENTITY=- build
```

Ad-hoc signing (`CODE_SIGN_IDENTITY=-`) gives the simulator build its
entitlements; an unsigned build (`CODE_SIGNING_ALLOWED=NO`) compiles but
cannot use the Keychain, so the core fails to start.
