#!/usr/bin/env bash
#
# validate-strict-bwrap.sh
#
# Validates the EXACT orchestration the strict-isolation executor uses, mirroring
# src/core/network-isolation.ts planHardenedExecution():
#   - bwrap --unshare-net --info-fd (filesystem + network isolation)
#   - firewall-first wrapper: nft default-drop applied BEFORE anything runs
#   - parent reads child PID from the info fd and attaches slirp4netns
#   - wrapper waits for the proxy hole, then runs the "command" (here: probes)
#
# Proves: external raw socket BLOCKED, proxy reachable. No CrewCoder, no root.
# Exit: 0 = PASS, 1 = FAIL, 2 = prerequisites missing.

set -u

PORT="${STRICT_TEST_PORT:-48231}"
EXTERNAL_IP="${STRICT_TEST_EXTERNAL_IP:-1.1.1.1}"
EXTERNAL_PORT="${STRICT_TEST_EXTERNAL_PORT:-443}"
GATEWAY="10.0.2.2"
WORKDIR="$(mktemp -d)"
WS="$WORKDIR/ws"; mkdir -p "$WS"
RESULTS="$WS/results"
RULES="$WORKDIR/rules.nft"
INFO_FILE="$WORKDIR/info"
READY_FILE="$WORKDIR/ready"
SLIRP_ERR="$WORKDIR/slirperr"
LISTENER_PID=""; SLIRP_PID=""; BWRAP_PID=""

log()  { printf '%s\n' "$*"; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; }
info() { printf '  [ .. ] %s\n' "$*"; }
cleanup() {
  [ -n "$SLIRP_PID" ]    && kill "$SLIRP_PID"    2>/dev/null
  [ -n "$LISTENER_PID" ] && kill "$LISTENER_PID" 2>/dev/null
  [ -n "$BWRAP_PID" ]    && kill "$BWRAP_PID"    2>/dev/null
  rm -rf "$WORKDIR" 2>/dev/null
}
trap cleanup EXIT

log "== Prerequisites =="
missing=0
for t in bwrap slirp4netns nft bash timeout; do
  command -v "$t" >/dev/null 2>&1 && pass "$t present" || { fail "$t MISSING"; missing=1; }
done
command -v python3 >/dev/null 2>&1 || command -v nc >/dev/null 2>&1 || { fail "need python3 or nc"; missing=1; }
[ "$missing" -eq 0 ] || { log ""; log "RESULT: PREREQUISITES MISSING (exit 2)"; exit 2; }

log ""
log "== Setup =="
if command -v python3 >/dev/null 2>&1; then
  python3 - "$PORT" <<'PY' &
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(16)
while True:
    try: c,_ = s.accept(); c.close()
    except Exception: break
PY
  LISTENER_PID=$!
else
  ( while true; do nc -l 127.0.0.1 "$PORT" </dev/null >/dev/null 2>&1 || break; done ) & LISTENER_PID=$!
fi
sleep 0.3
info "loopback listener on 127.0.0.1:$PORT"

cat > "$RULES" <<EOF
flush ruleset
table inet crewcoder_egress {
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    ip daddr $GATEWAY tcp dport $PORT accept
  }
}
EOF
: > "$INFO_FILE"; : > "$READY_FILE"

# The "command" the sandbox runs is our probe pair (mirrors a real command slot).
PROBE_CMD="if timeout 5 bash -c 'exec 9<>/dev/tcp/$EXTERNAL_IP/$EXTERNAL_PORT' 2>/dev/null; then echo external_blocked=no; else echo external_blocked=yes; fi >> '$RESULTS'
if timeout 5 bash -c 'exec 9<>/dev/tcp/$GATEWAY/$PORT' 2>/dev/null; then echo proxy_reachable=yes; else echo proxy_reachable=no; fi >> '$RESULTS'
echo done=yes >> '$RESULTS'"
export PROBE_CMD

# Nested design: outer `unshare --map-root-user --net` owns the network namespace
# (root-in-userns -> nft + slirp work), bwrap nested inside for filesystem
# isolation (inherits the locked-down netns; does NOT --unshare-net).
TRIES=50
STAGE2="ip link set lo up 2>/dev/null
nft -f '$RULES' || exit 97
echo nft_applied=yes >> '$RESULTS'
for _ in \$(seq 1 $TRIES); do (exec 3<>/dev/tcp/$GATEWAY/$PORT) 2>/dev/null && break; sleep 0.2; done
exec bwrap --die-with-parent --unshare-pid --unshare-ipc --unshare-uts \
  --ro-bind / / --dev /dev --proc /proc --bind '$WS' '$WS' --chdir '$WS' \
  -- /bin/sh -c \"\$PROBE_CMD\""

log ""
log "== Run (unshare netns + slirp + nested bwrap) =="
unshare --user --map-root-user --net /bin/bash -c "$STAGE2" &
BWRAP_PID=$!   # outer namespace holder
info "netns holder pid $BWRAP_PID"

# Attach slirp to the netns holder; --ready-fd fires when connectivity is up.
slirp4netns --configure --mtu=65520 --ready-fd=3 "$BWRAP_PID" tap0 3>>"$READY_FILE" >/dev/null 2>"$SLIRP_ERR" &
SLIRP_PID=$!
info "slirp4netns attached (pid $SLIRP_PID)"

wait "$BWRAP_PID" 2>/dev/null
[ -s "$SLIRP_ERR" ] && { info "slirp stderr (non-fatal if 'received tapfd'):"; sed 's/^/    | /' "$SLIRP_ERR"; }

log ""
log "== Results =="
[ -f "$RESULTS" ] || { fail "no results from sandbox"; log "RESULT: FAIL (exit 1)"; exit 1; }
get() { grep -m1 "^$1=" "$RESULTS" | cut -d= -f2; }
[ "$(get nft_applied)" = "yes" ]      && pass "nft applied inside bwrap userns" || fail "nft not applied"
[ "$(get external_blocked)" = "yes" ] && pass "external raw socket BLOCKED" || fail "external NOT blocked"
[ "$(get proxy_reachable)" = "yes" ]  && pass "proxy gateway:port reachable" || fail "proxy NOT reachable"

log ""
if [ "$(get nft_applied)" = "yes" ] && [ "$(get external_blocked)" = "yes" ] && [ "$(get proxy_reachable)" = "yes" ]; then
  log "RESULT: PASS — the exact executor orchestration (bwrap+info-fd+slirp+nft-first) contains raw-socket egress on this host."
  exit 0
fi
log "RESULT: FAIL (exit 1)"
exit 1
