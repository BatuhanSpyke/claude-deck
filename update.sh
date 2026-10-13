#!/bin/zsh
# Quit Claude Deck, install the freshly packaged build, reopen it.
# Detached with nohup so it survives being run from inside Deck itself.
APP="$HOME/Applications/Claude Deck.app"
NEW="$(dirname "$0")/dist/Claude Deck-darwin-arm64/Claude Deck.app"
osascript -e 'tell application "Claude Deck" to quit' 2>/dev/null
for i in {1..40}; do pgrep -f "Claude Deck.app/Contents/MacOS" >/dev/null || break; sleep 0.25; done
rm -rf "$APP" && cp -R "$NEW" "$APP" && touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null
open "$APP"
