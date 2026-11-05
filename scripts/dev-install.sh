#!/usr/bin/env bash
# Install this checkout into the Omarchy plugin directory for testing.
#
# The shell watches ~/.config/omarchy/plugins and hot-reloads on every file
# write, so copying files one at a time into a live plugin could load a half
# copied tree. Instead: validate the source, copy it into a hidden staging
# directory (the watcher ignores hidden dirs), validate again, then swap it
# into place with one rename.
#
# Usage: scripts/dev-install.sh [--enable]
set -euo pipefail

ID="io.github.slinn-01.taskbar"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGINS="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
DEST="$PLUGINS/$ID"
STAGING="$PLUGINS/.$ID.staging"
OLD="$PLUGINS/.$ID.old"

omarchy-plugin-validate "$SRC"

mkdir -p "$PLUGINS"
rm -rf "$STAGING" "$OLD"
rsync -a --delete \
  --exclude '.git' --exclude 'tests' --exclude 'scripts' --exclude 'node_modules' \
  "$SRC/" "$STAGING/"
omarchy-plugin-validate "$STAGING"

if [[ -d $DEST ]]; then
  mv "$DEST" "$OLD"
fi
mv "$STAGING" "$DEST"
rm -rf "$OLD"
echo "Installed $ID -> $DEST"

# The shell must know the plugin before it can be enabled; the file watcher
# picks it up after a debounce, so ask for the rescan directly as well.
omarchy-shell -q shell rescanPlugins || true

if [[ ${1:-} == "--enable" ]]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    omarchy plugin list --json 2>/dev/null | grep -q "\"$ID\"" && break
    sleep 0.3
  done
  omarchy plugin enable "$ID"
fi
