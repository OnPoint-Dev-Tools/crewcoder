#!/usr/bin/env bash
#
# validate-strict-sandbox.sh
#
# Standalone containment self-check for CrewCoder's strict network-isolation
# design. It requires NO CrewCoder install and no root — just a Linux host with
# unprivileged user namespaces, bwrap, slirp4netns, and nft. Copy this one file
# to any Linux box (VPS, VM, WSL2, this dev machine) and run it.
#
#   bash validate-strict-sandbox.sh
#
# It reproduces the exact isolation the executor will use:
#   - a child in its own network namespace (only lo, no route out)
#   - slirp4netns attached for connectivity (gateway 10.0.2.2 -> host loopback)
#   - an nft ruleset that default-drops egress and permits ONLY tcp to the
#     proxy gateway:port
# Then it PROVES containment:
#   - POSITIVE: the allowed proxy port IS reachable from inside
#   - NEGATIVE: a raw socket to an external IP (1.1.1.1:443) IS blocked
#   - CONTROL:  before nft, that same external IP is reachable (so we know the
#               block is nft doing its job, not a broken slirp)
#
# Exit codes: 0 = PASS (containment works), 1 = FAIL, 2 = prerequisites missing.

set -u

PORT="${STRICT_TEST_PORT:-48213}"
EXTERNAL_IP="${STRICT_TEST_EXTERNAL_IP:-1.1.1.1}"
EXTERNAL_PORT="${STRICT_TEST_EXTERNAL_PORT:-443}"
GATEWAY="10.0.2.2"
WORKDIR="$(mktemp -d)"
RESULTS="$WORKDIR/results"
RULES="$WORKDIR/rules.nft"
GO_FIFO="$WORKDIR/go.fifo"
READY_FILE="$WORKDIR/ready"
SLIRP_ERR="$WORKDIR/slirperr"
LISTENER_PID=""
SLIRP_PID=""
CHILD_PID=""

log()  { printf '%s\n' "$*"; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; }
info() { printf '  [ .. ] %s\n' "$*"; }

cleanup() {
  [ -n "$SLIRP_PID" ]    && kill "$SLIRP_PID"    2>/dev/null
  [ -n "$LISTENER_PID" ] && kill "$LISTENER_PID" 2>/dev/null
  [ -n "$CHILD_PID" ]    && kill "$CHILD_PID"    2>/dev/null
  rm -rf "$WORKDIR" 2>/dev/null
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
log "== Prerequisites =="
missing=0
for tool in bwrap slirp4netns nft unshare timeout; do
  if command -v "$tool" >/dev/null 2>&1; then pass "$tool present"; else fail "$tool MISSING"; missing=1; fi
done

userns="unknown"
if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "1" ] && userns="enabled" || userns="disabled"
elif [ -r /proc/sys/user/max_user_namespaces ]; then
  [ "$(cat /proc/sys/user/max_user_namespaces)" -gt 0 ] 2>/dev/null && userns="enabled" || userns="disabled"
fi
if [ "$userns" = "disabled" ]; then fail "unprivileged user namespaces disabled"; missing=1; else pass "unprivileged user namespaces: $userns"; fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v nc >/dev/null 2>&1; then
  fail "need python3 or nc for the loopback listener"; missing=1
fi

if [ "$missing" -ne 0 ]; then
  log ""
  log "RESULT: PREREQUISITES MISSING (exit 2)"
  if command -v apt >/dev/null 2>&1; then
    log "Install (Ubuntu/Debian): sudo apt install -y bubblewrap slirp4netns nftables netcat-openbsd"
  elif command -v pacman >/dev/null 2>&1; then
    log "Install (Arch):          sudo pacman -S --needed bubblewrap slirp4netns nftables openbsd-netcat"
  elif command -v dnf >/dev/null 2>&1; then
    log "Install (Fedora/RHEL):   sudo dnf install -y bubblewrap slirp4netns nftables nmap-ncat"
  else
    log "Install the missing tools: bubblewrap, slirp4netns, nftables (and python3 or nc)."
  fi
  exit 2
fi

# ---------------------------------------------------------------------------
# 2. Host-side loopback listener (stands in for the filtering proxy)
# ---------------------------------------------------------------------------
log ""
log "== Setup =="
if command -v python3 >/dev/null 2>&1; then
  python3 - "$PORT" <<'PY' &
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1])))
s.listen(16)
while True:
    try:
        c, _ = s.accept(); c.close()
    except Exception:
        break
PY
  LISTENER_PID=$!
else
  ( while true; do nc -l 127.0.0.1 "$PORT" </dev/null >/dev/null 2>&1 || break; done ) &
  LISTENER_PID=$!
fi
sleep 0.3
info "loopback listener on 127.0.0.1:$PORT (pid $LISTENER_PID)"

# nft ruleset — identical shape to src/core/network-isolation.ts
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
info "nft ruleset written ($RULES)"

mkfifo "$GO_FIFO"
: > "$READY_FILE"

# ---------------------------------------------------------------------------
# 3. Child in an isolated netns: control test -> apply nft -> contained tests
# ---------------------------------------------------------------------------
probe() { # host port -> 0 if TCP connect succeeds within 5s, else non-zero
  timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
}
export -f probe

unshare --user --map-root-user --net bash -c '
  set -u
  # Block until the parent says slirp is ready.
  read _ < "'"$GO_FIFO"'"
  ip link set lo up 2>/dev/null

  # CONTROL: before firewall, external egress should work via slirp.
  if probe "'"$EXTERNAL_IP"'" "'"$EXTERNAL_PORT"'"; then echo "control_external=reachable"; else echo "control_external=unreachable"; fi >> "'"$RESULTS"'"

  # Apply the egress firewall.
  if nft -f "'"$RULES"'" 2>"'"$WORKDIR"'/nfterr"; then echo "nft_applied=yes"; else echo "nft_applied=no"; fi >> "'"$RESULTS"'"

  # NEGATIVE: raw socket to external IP must now be blocked.
  if probe "'"$EXTERNAL_IP"'" "'"$EXTERNAL_PORT"'"; then echo "external_blocked=no"; else echo "external_blocked=yes"; fi >> "'"$RESULTS"'"

  # POSITIVE: the allowed proxy hole must still be reachable.
  if probe "'"$GATEWAY"'" "'"$PORT"'"; then echo "proxy_reachable=yes"; else echo "proxy_reachable=no"; fi >> "'"$RESULTS"'"
' &
CHILD_PID=$!
info "isolated child pid $CHILD_PID"

# Attach slirp4netns to the child netns; --ready-fd writes "1" when connectivity is up.
slirp4netns --configure --mtu=65520 --ready-fd=3 "$CHILD_PID" tap0 3>>"$READY_FILE" >/dev/null 2>"$SLIRP_ERR" &
SLIRP_PID=$!
info "slirp4netns pid $SLIRP_PID, waiting for ready..."

ready=0
for _ in $(seq 1 50); do   # up to ~10s
  if [ -s "$READY_FILE" ]; then ready=1; break; fi
  if ! kill -0 "$SLIRP_PID" 2>/dev/null; then break; fi   # slirp exited early
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then break; fi    # child exited early
  sleep 0.2
done

if [ "$ready" -ne 1 ]; then
  log ""
  log "== Diagnostics =="
  kill -0 "$SLIRP_PID" 2>/dev/null && info "slirp still running" || info "slirp exited"
  kill -0 "$CHILD_PID" 2>/dev/null && info "child still running" || info "child exited"
  if [ -s "$SLIRP_ERR" ]; then log "  slirp4netns stderr:"; sed 's/^/    | /' "$SLIRP_ERR"; else info "slirp4netns produced no stderr"; fi
  log ""
  log "RESULT: FAIL — slirp4netns never signalled ready (exit 1)"
  exit 1
fi
info "slirp ready; releasing child"
echo go > "$GO_FIFO"

wait "$CHILD_PID" 2>/dev/null
[ -s "$SLIRP_ERR" ] && { info "slirp4netns stderr (non-fatal):"; sed 's/^/    | /' "$SLIRP_ERR"; }

# ---------------------------------------------------------------------------
# 4. Verdict
# ---------------------------------------------------------------------------
log ""
log "== Results =="
[ -f "$RESULTS" ] || { log "RESULT: FAIL — child produced no results (exit 1)"; exit 1; }

get() { grep -m1 "^$1=" "$RESULTS" 2>/dev/null | cut -d= -f2; }
control="$(get control_external)"
nft_applied="$(get nft_applied)"
external_blocked="$(get external_blocked)"
proxy_reachable="$(get proxy_reachable)"

[ "$control" = "reachable" ]      && pass "control: external reachable before nft (slirp works)" || info "control: external '$control' before nft (offline host? informational)"
[ "$nft_applied" = "yes" ]        && pass "nft ruleset applied" || fail "nft ruleset did NOT apply"
[ "$external_blocked" = "yes" ]   && pass "external raw socket BLOCKED after nft" || fail "external raw socket NOT blocked"
[ "$proxy_reachable" = "yes" ]    && pass "proxy gateway:port reachable" || fail "proxy gateway:port NOT reachable"

log ""
if [ "$nft_applied" = "yes" ] && [ "$external_blocked" = "yes" ] && [ "$proxy_reachable" = "yes" ]; then
  log "RESULT: PASS — this host can strictly contain raw-socket egress. The executor is safe to enable here."
  exit 0
fi
log "RESULT: FAIL — this host cannot prove containment. Keep CrewCoder on the proxy path here."
exit 1
