#!/usr/bin/env bash
# =============================================================================
# Import the Developer ID Application cert (CSC_LINK / CSC_KEY_PASSWORD) into a
# dedicated temporary keychain, add it to the user search list, and export the
# identity hash (CATE_MAC_SIGN_IDENTITY via $GITHUB_ENV) so build-companion-
# tarball.mjs can codesign the bundled native binaries (node, rg, node-pty's
# pty.node + spawn-helper) BEFORE packing them.
#
# Why: Apple's notarytool recurses into companion-host.tgz and rejects unsigned
# Mach-O ("not signed with a valid Developer ID certificate"), so the daemon
# binaries must carry a Developer ID + hardened-runtime signature like the app.
#
# The keychain is added to the search list so codesign can locate the identity
# (codesign --keychain alone is unreliable). electron-builder later signs the app
# with its OWN --keychain, so this extra keychain doesn't make that ambiguous.
#
# No-op (exit 0, no identity exported) when MAC_CERTS is absent — the build then
# stays unsigned and notarization fails loudly, same as before.
# =============================================================================
set -euo pipefail

if [ -z "${CSC_LINK:-}" ]; then
  echo "No MAC_CERTS secret set — skipping companion-native signing setup."
  echo "(Notarization will reject the unsigned bundled binaries.)"
  exit 0
fi

TMP="${RUNNER_TEMP:-/tmp}"
KEYCHAIN="$TMP/cate-companion-signing.keychain-db"
CERT="$TMP/cate-companion-cert.p12"
KPASS="$(uuidgen)"

# Fresh keychain, unlocked, with a long auto-lock timeout so it is still usable
# from the later build step in the same runner session.
security create-keychain -p "$KPASS" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KPASS" "$KEYCHAIN"

printf '%s' "$CSC_LINK" | base64 --decode > "$CERT"
security import "$CERT" -k "$KEYCHAIN" -P "${CSC_KEY_PASSWORD:-}" -T /usr/bin/codesign
rm -f "$CERT"
# Let codesign use the imported key without an interactive prompt.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KPASS" "$KEYCHAIN" >/dev/null

# Add this keychain to the user search list (in front, keeping the existing
# login keychain) so codesign can locate the identity. `codesign --keychain
# <path>` alone is unreliable for a keychain not in the search list ("The
# specified item could not be found in the keychain"), so the build script signs
# via the search list. electron-builder later signs the app with its OWN
# `--keychain`, so this extra keychain doesn't make its lookup ambiguous.
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | sed 's/"//g')

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" \
  | awk '/Developer ID Application/ {print $2; exit}')"
if [ -z "$IDENTITY" ]; then
  echo "No 'Developer ID Application' identity in the provided cert:" >&2
  security find-identity -v -p codesigning "$KEYCHAIN" >&2 || true
  exit 1
fi

echo "CATE_MAC_SIGN_IDENTITY=$IDENTITY" >> "$GITHUB_ENV"
echo "Companion natives will be signed with Developer ID identity $IDENTITY"
