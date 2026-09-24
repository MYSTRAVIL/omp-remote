#!/usr/bin/env bash
# Atomic PWA release for omp-remote on the VPS.
#
# Runs ON the server (piped over ssh). Lands a built apps/web/dist tarball as a
# versioned release under /var/www/omp-remote-releases/<build-id> and flips the
# nginx-served symlink /var/www/omp-remote to it with a single atomic rename — no
# nginx reload, no downtime. The first run migrates the legacy directory layout
# into a preserved release. Keeps the last N releases for one-command rollback.
#
# Invoked by scripts/deploy/web.ts as:
#   ssh <host> 'bash -s -- <build-id> <tarball-path> [keep]' < deploy-web.sh
# where <tarball-path> is a gzip tar of the flat dist/ contents already on the box.
set -euo pipefail

build_id="${1:?build id required}"
tarball="${2:?tarball path required}"
keep="${3:-5}"

root=/var/www/omp-remote
releases=/var/www/omp-remote-releases
dest="$releases/$build_id"

[ -f "$tarball" ] || { echo "deploy-web: tarball not found: $tarball" >&2; exit 1; }

mkdir -p "$releases"
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tarball" -C "$dest"
rm -f "$tarball"
# nginx-served: directories traversable, files world-readable.
find "$dest" -type d -exec chmod 755 {} +
find "$dest" -type f -exec chmod 644 {} +

# One-time migration: a real directory root is preserved as a release so nothing
# is lost, then removed so the symlink can take its place.
if [ -e "$root" ] && [ ! -L "$root" ]; then
  cp -a "$root" "$releases/legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  rm -rf "$root"
fi

# Atomic flip: create the new symlink under a temp name, then rename over the
# live one. rename(2) is atomic, so a request never sees a missing root.
ln -sfnT "$dest" "$root.next"
mv -T "$root.next" "$root"

# Prune releases beyond `keep` (newest first); never delete the live target.
current="$(readlink -f "$root")"
n=0
while IFS= read -r d; do
  d="${d%/}"
  n=$((n + 1))
  [ "$n" -le "$keep" ] && continue
  [ "$(readlink -f "$d")" = "$current" ] && continue
  rm -rf "$d"
done < <(ls -1dt "$releases"/*/ 2>/dev/null)

echo "DEPLOYED build=$build_id -> $current"
for f in index.html main.js sw.js styles.css; do
  [ -f "$root/$f" ] && printf '%s %s\n' "$f" "$(sha256sum "$root/$f" | cut -d' ' -f1)"
done
printf 'sw-cache=%s\n' "$(grep -o 'omp-remote-shell-[a-z0-9]*' "$root/sw.js" 2>/dev/null | head -1)"
