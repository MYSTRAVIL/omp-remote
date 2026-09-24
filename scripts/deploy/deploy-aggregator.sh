#!/usr/bin/env bash
# Atomic aggregator release for omp-remote on the VPS.
#
# Runs ON the server as root (piped over ssh by scripts/deploy/aggregator.ts).
# Lands a compiled binary as a versioned release under
# /usr/local/lib/omp-remote/releases/<build-id>/ and flips the systemd
# ExecStart target (/usr/local/lib/omp-remote/omp-remote-aggregator, a symlink)
# with a single atomic rename, then restarts the service. If the new build does
# not come up listening on the loopback port, it rolls the symlink back to the
# previous release and restarts — a bad build never leaves the relay down.
#
# Invoked as:
#   ssh <host> 'bash -s -- <build-id> <binary-path> [keep]' < deploy-aggregator.sh
# where <binary-path> is the fresh binary already streamed onto the box.
set -euo pipefail

build_id="${1:?build id required}"
binsrc="${2:?binary path required}"
keep="${3:-5}"

lib=/usr/local/lib/omp-remote
releases="$lib/releases"
live="$lib/omp-remote-aggregator"     # systemd ExecStart target (kept a symlink)
svc=omp-remote-aggregator
port=8788

[ -f "$binsrc" ] || { echo "deploy-aggregator: binary not found: $binsrc" >&2; exit 1; }

mkdir -p "$releases"
dest="$releases/$build_id"
mkdir -p "$dest"
install -m 0755 "$binsrc" "$dest/omp-remote-aggregator"
rm -f "$binsrc"

# Remember what to fall back to if the new build fails to boot.
prev=""
[ -L "$live" ] && prev="$(readlink -f "$live")"

# One-time migration: the live path is still a hand-deployed regular file, not a
# symlink. Preserve it as a release so rollback has a target, then remove it so
# the symlink can take its place.
if [ -e "$live" ] && [ ! -L "$live" ]; then
  mig="$releases/legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$mig"
  cp -a "$live" "$mig/omp-remote-aggregator"
  rm -f "$live"
  prev="$mig/omp-remote-aggregator"
fi

flip() {
  # Atomic: stage the symlink under a temp name, then rename(2) over the live one.
  ln -sfnT "$1" "$live.next"
  mv -T "$live.next" "$live"
}

# Is the aggregator listening on its loopback port yet? (bash /dev/tcp — no curl
# dependency; the service may briefly be "activating" right after restart.)
listening() {
  for _ in $(seq 1 20); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 0.25
  done
  return 1
}

flip "$dest/omp-remote-aggregator"
systemctl restart "$svc"

if ! systemctl is-active --quiet "$svc" || ! listening; then
  echo "deploy-aggregator: new build did not come up on :$port — rolling back" >&2
  if [ -n "$prev" ]; then
    flip "$prev"
    systemctl restart "$svc" || true
  fi
  exit 1
fi

current="$(readlink -f "$live")"
echo "DEPLOYED aggregator build=$build_id -> $current"
echo "service=$(systemctl is-active "$svc") listening=127.0.0.1:$port"
if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/auth/login/options" || echo 000)"
  echo "auth/login/options=$code"
fi
sha256sum "$live" | awk '{print "sha256="$1}'

# Prune releases beyond `keep` (newest first); never delete the live target.
n=0
while IFS= read -r d; do
  d="${d%/}"
  n=$((n + 1))
  [ "$n" -le "$keep" ] && continue
  [ "$(readlink -f "$d/omp-remote-aggregator" 2>/dev/null)" = "$current" ] && continue
  rm -rf "$d"
done < <(ls -1dt "$releases"/*/ 2>/dev/null)
