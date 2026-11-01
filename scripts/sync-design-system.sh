#!/bin/sh
# Copies the Binary Elements design system files the admin pages use. Usage: scripts/sync-design-system.sh <be-design-system checkout>
set -eu
src=${1:?usage: sync-design-system.sh <path-to-be-design-system-checkout>}
dst="$(dirname "$0")/../src/admin/assets/be"
mkdir -p "$dst"
cp "$src/tokens.css" "$src/components.css" "$src/assets/logos/be-mark-cyan.png" "$src/assets/logos/be-mark-red.png" "$dst/"
git -C "$src" rev-parse --short HEAD > "$dst/VERSION"
