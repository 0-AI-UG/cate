# Cate for iOS

The mobile shell (architecture 15, `shells/mobile`). The app is native
SwiftUI; the client core runs headless in a hidden `WKWebView`
(`Cate/Core/Web/core.js`, built from `src/shells/mobile/core` by
`npm run build:mobile`). The bridge and the core API are
`src/shells/mobile/contract.ts`.

- `Cate/Core/`: the core's host (`CoreHost`), the bridge (`ShellBridge`),
  device storage, mDNS, and loopback routing for web views (`LoopbackPorts`).
- `Cate/App/`: the UI (iOS 26, Liquid Glass). Workspaces and joining; a
  workspace with its agents, each a chat (`AgentChatView`: a new agent
  starts from an empty chat whose box picks a terminal agent or a T3 Code
  model and a worktree; replies, task decisions, one tap into the agent's
  terminal or T3 Code chat, Review into a review panel filtered to the
  agent), keep-awake and alerts per computer; notifications (`Notifier`:
  banners, push registration, Reply); and one view per panel type:
  terminal (SwiftTerm), files (the shared buffer as text, previews, a file
  browser), browser and chat (`WKWebView`s in the workspace's data store),
  diff review, canvas (a map of its nodes; `+` adds a panel or an agent to
  it) and surface (the type picker). A new panel or agent goes where you
  are: on the canvas it was asked from, at the spot tapped in its map
  (`PlacementSheet`), or in the dock from anywhere else.

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
