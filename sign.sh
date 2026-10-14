#!/bin/zsh
# Sign the Mac app with the project's self-signed certificate, so every build has the same identity.
# macOS ties privacy permissions (Desktop/Documents/Downloads access…) to that identity: with a
# throwaway ad-hoc signature it forgets them after every update. Falls back to ad-hoc without a cert.
#   ./sign.sh "dist/Claude Deck-darwin-arm64/Claude Deck.app"
# Cert: $DECK_P12 / $DECK_P12_PASSWORD, or ~/Developer/ClaudeDeck-signing/deck.p12 + password.txt
set -e
APP="$1"
P12="${DECK_P12:-$HOME/Developer/ClaudeDeck-signing/deck.p12}"
PASS="${DECK_P12_PASSWORD:-$(cat "$HOME/Developer/ClaudeDeck-signing/password.txt" 2>/dev/null)}"
# node-pty's spawn-helper must be executable or no terminal can start
chmod +x "$APP/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/"*/spawn-helper 2>/dev/null || true
if [ ! -f "$P12" ] || [ -z "$PASS" ]; then
  echo "sign.sh: no certificate, signing ad-hoc"
  codesign --force --deep --sign - "$APP"; exit 0
fi
# Use a throwaway keychain so the login keychain is never touched
KC="$(mktemp -d)/deck-sign.keychain-db"; KCPASS="$(openssl rand -hex 12)"
OLD=(${(f)"$(security list-keychains -d user | tr -d '"' | sed 's/^ *//')"})
cleanup() { security list-keychains -d user -s "${OLD[@]}"; security delete-keychain "$KC" 2>/dev/null || true; }
trap cleanup EXIT
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security import "$P12" -k "$KC" -P "$PASS" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPASS" "$KC" >/dev/null 2>&1
security list-keychains -d user -s "$KC" "${OLD[@]}"
HASH=$(security find-certificate -c "Claude Deck Self-Signed" -Z "$KC" | awk '/SHA-1/{print $3}')
codesign --force --deep --keychain "$KC" --sign "$HASH" "$APP"
codesign -v "$APP"
echo "sign.sh: signed with Claude Deck Self-Signed ($HASH)"
