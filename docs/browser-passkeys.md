# Browser passkeys

Cate's macOS bridge uses Apple's public AuthenticationServices **browser** APIs,
with the actual requesting origin. It does not use Electron's associated-domain
passkey API or pretend arbitrary websites have associated themselves with Cate.
Private keys stay with the operating system/provider or security key.

## Enable a signed macOS build after Apple approval

1. The organization Account Holder requests Apple's
   [macOS Browsers Passkeys capability](https://developer.apple.com/contact/request/macos-browsers-passkeys/)
   for `com.cate.app`. Apple decides eligibility; declaring an entitlement alone
   does not authorize it.
2. Enable the approved capability for the App ID and generate a **Developer ID
   provisioning profile** for it. Use the same team as Cate's signing identity.
3. Set the repository Actions secret `CATE_PASSKEYS_PROFILE_BASE64` to the base64
   encoding of the downloaded profile. Existing Developer ID signing and
   notarization secrets are still required. For local packaging, set
   `CATE_PASSKEYS_PROFILE` to the profile's absolute path instead.
4. Build/package normally. The `beforePack` hook builds a universal Node-API addon
   (Apple Silicon + Intel), validates profile expiration, App ID and entitlement,
   selects the profile, and generates the main application's entitlements.
   Helper processes retain the existing helper entitlements. The `afterSign`
   hook checks the embedded profile, effective entitlement and addon signature.
5. Test the signed app on macOS 14.4 or later with an existing iCloud/third-party
   provider passkey and a USB security key. Test registration, excluded
   credentials, multiple accounts, cancellation, navigation during a prompt,
   and closing the panel/window. Test the actual provider versions you ship for.
   Apple approval alone is **not** proof these ceremonies work.

macOS browser registration and external-link handling are tracked separately in
[PR #694](https://github.com/0-AI-UG/cate/pull/694).

`npm run build:passkeys` builds the addon locally with Xcode Command Line Tools.
An unsigned development build cannot exercise managed-entitlement authentication;
it preserves Chromium's original WebAuthn API instead. Supplying no profile to
packaging likewise leaves this feature disabled. The addon is never loaded on
Windows or Linux. Normal `npm run build` does not require a macOS compiler.

## Scope and current limits

| Environment/store | Behavior |
| --- | --- |
| macOS 14.4+, approved signed Cate | Bridge for explicit WebAuthn registration/assertion using system platform providers or security keys; requires signed-device validation |
| iCloud Keychain / third-party macOS providers | Uses the system provider UI; availability depends on provider registration and OS support |
| Windows Hello / Windows passkey providers | Chromium's original Windows WebAuthn path remains intact; not hardware-tested in this macOS workspace |
| Linux security keys | Chromium's original WebAuthn path remains intact; full account/PIN/provider UI is not implemented or verified |
| Google Password Manager synced passkeys | No Chrome profile/Google account sync integration; not automatically available in Cate |
| Passkeys stored only in a local Chrome profile | No import or access to Chrome's private credential store |
| Passkeys created in Chrome but stored in iCloud/Windows Hello | Availability follows the actual OS credential store, not which browser created them |

The macOS bridge currently supports **explicit, top-level** `create()` and `get()`
requests. It validates secure origins and RP IDs (including private public
suffixes), uses only the calling frame's trusted origin, bounds requests, and
cancels native prompts on abort, timeout, navigation or owner destruction.

It does **not** claim full Chrome parity. Conditional mediation/passkey autofill,
cross-origin iframes, Related Origin Requests, enterprise attestation, PRF,
largeBlob, credential-management signal APIs, and Google Password Manager sync
are not implemented. Unsupported extensions are rejected rather than reported
as evaluated. Ordinary password autofill is separate. JavaScript credential
responses provide normal WebAuthn fields, response methods and `toJSON`; they
are reconstructed wrappers rather than Chromium-owned credential instances.

## iPhone / nearby-device QR sign-in

Cate uses the default modal `ASAuthorizationController.performRequests()` path.
Apple documents that this sheet offers a nearby-device passkey option and falls
back to a QR code when no matching local passkey exists. Do not switch to
`preferImmediatelyAvailableCredentials`: that suppresses the QR fallback.
The native response uses Apple's reported attachment, so a phone credential
returned by the platform provider is not mislabeled as local to the Mac.

In an approved signed build, start the website's explicit passkey sign-in,
select **Other options / Passkey from nearby device** if needed, scan with the
iPhone Camera, and approve on the phone. Keep the devices nearby, Bluetooth on,
and both connected to the internet. The passkey must be available on that iPhone
for the site's relying party. Apple owns pairing, proximity checks, and the
encrypted exchange; Cate receives the assertion for the requesting website.

This native route still requires Apple's browser entitlement for arbitrary
websites. It is not an unsigned-build workaround. QR authentication in Cate has
**not yet been verified with a real iPhone**; the bridge keeps its advertised
`hybridTransport` capability false pending that validation.

Signed-device acceptance test:

1. Use an account with a passkey available on the iPhone. In Cate, start an
   explicit passkey sign-in and select the nearby-device option.
2. Verify the QR appears, scan it, approve on the iPhone, and confirm the website
   actually accepts the assertion and signs in within the same Cate panel.
3. Repeat with no matching local Mac passkey, both with a website credential
   allow-list and with an empty allow-list (account discovery).
4. Cancel the sheet, abort from the website, navigate, and close the panel during
   pairing. Verify the request cancels and no late result reaches another page.

Unit tests cover response forwarding, not Bluetooth, pairing, or Face ID.
Reference: [Apple's modal and nearby-device passkey flow](https://developer.apple.com/videos/play/wwdc2022/10092/).

## Verification

```sh
npm run build:passkeys
npm run typecheck
npx vitest run src/main/browser/passkeyPolicy.test.ts src/main/browser/browserPasskeys.test.ts src/main/browser/passkeyAttestation.test.ts src/preload/passkeyPageBridge.test.ts
npm run build
npx playwright test e2e/browser-session-persistence.spec.ts -g 'lists a saved password'
```

The password E2E test selects the actual popup item, verifies both filled fields,
and checks popup placement under canvas and page zoom. No test uses real saved
passwords or submits a production login.

References: [Apple browser API](https://developer.apple.com/documentation/authenticationservices/authenticating-people-by-using-passkeys-in-browser-apps),
[Apple entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential),
[Windows WebAuthn](https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis),
[Google supported environments](https://developers.google.com/identity/passkeys/supported-environments).
