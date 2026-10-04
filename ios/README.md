# Cate for iOS

The mobile shell (architecture 15, `shells/mobile`). The app is native
SwiftUI; the client core runs headless in a hidden `WKWebView`
(`Cate/Core/Web/core.js`, built from `src/shells/mobile/core` by
`npm run build:mobile`). The bridge and the core API are
`src/shells/mobile/contract.ts`.

- `Cate/Core/`: the core's host (`CoreHost`), the bridge (`ShellBridge`),
  device storage, mDNS, and loopback routing for web views (`LoopbackPorts`).
- `Cate/App/`: the UI. The agents home (every workspace's agents, the
  session view with replies, New Task, review and ship), notifications
  (`Notifier`: banners, push registration, Reply),
  workspaces and joining (with keep-awake and alerts per computer), and one
  view per panel type:
  terminal (SwiftTerm), files (the shared buffer as text, previews, a file
  browser), browser and chat (`WKWebView`s in the workspace's data store),
  diff review, canvas (a map of its nodes) and surface (the type picker).

- `Notifications/`: the notification service extension, which opens each
  push sealed for this device; `Shared/` holds the push key (a Keychain group
  both targets share) and the code that opens a push.

The app is `com.0ai.cate.ios` and its extension
`com.0ai.cate.ios.notifications`, on team `F7PH54XQ6J` (automatic signing).
Pushes need a signed build (the `aps-environment` and Keychain group
entitlements) and Cate Connect with the APNs key of that team
(`CATE_CONNECT_APNS_*`, see the cate-connect README).

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
