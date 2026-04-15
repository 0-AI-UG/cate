# Packaging Security Notes

## macOS hardened runtime

- `com.apple.security.cs.allow-jit` is retained because the Electron/V8 runtime requires JIT on macOS.
- `com.apple.security.cs.disable-executable-page-protection` is retained pending packaged-build verification that Electron 41 can launch reliably without it in this app.
- `com.apple.security.network.client` remains required for browser panels, update checks, crash reporting, and remote API access.
- `com.apple.security.files.user-selected.read-write` remains required for native open/save flows.
- `com.apple.security.network.server` is temporarily retained until packaged-build verification confirms that local preview and port-detection workflows do not require it.

Removed entitlements:

- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.allow-dyld-environment-variables`
- `com.apple.security.cs.disable-library-validation`
- `com.apple.security.device.audio-input`
- `com.apple.security.device.camera`
