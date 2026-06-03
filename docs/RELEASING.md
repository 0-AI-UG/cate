# Releasing Cate

Releases are cut by pushing a `v*` tag, which triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml): it builds
and signs the app for macOS, Windows, and Linux, builds the per-target
companion + pi tarballs, uploads everything to a draft GitHub Release, and
un-drafts it once every job succeeds.

## Code-signing secrets

Configure these as repository secrets (Settings → Secrets and variables →
Actions). Builds still succeed without them — they just produce **unsigned**
artifacts — so you can land changes before the certs are provisioned.

### macOS (signing + notarization)

| Secret | What it is |
| --- | --- |
| `MAC_CERTS` | base64 of the "Developer ID Application" `.p12` |
| `MAC_CERTS_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |

### Windows (signing)

| Secret | What it is |
| --- | --- |
| `WINDOWS_CERTS` | base64 of the code-signing `.pfx` (OV or EV) |
| `WINDOWS_CERTS_PASSWORD` | password for that `.pfx` |

electron-builder reads these as `CSC_LINK` / `CSC_KEY_PASSWORD` and signs the
NSIS installer + the app `.exe`, timestamped via DigiCert's RFC-3161 server so
the signature outlives the certificate. Signing removes the SmartScreen
"unknown publisher" warning new users hit on first install.

To produce the base64 for either platform:

```bash
base64 -i path/to/cert.pfx | tr -d '\n'   # paste the output into the secret
```

> **Note:** Certificate Authorities are moving OV Windows certificates onto
> hardware tokens / cloud key stores, which a `.pfx` file can't represent. If
> you can't get a file-based cert, switch the Windows step to
> [Azure Trusted Signing](https://www.electron.build/code-signing#using-azure-trusted-signing-beta)
> (`win.azureSignOptions`) instead of `CSC_LINK`.

## Local packaging

`npm run package:mac` / `package:win` / `package:linux` build locally. The
`package:win:unsigned` variant skips signing for quick local Windows builds.
