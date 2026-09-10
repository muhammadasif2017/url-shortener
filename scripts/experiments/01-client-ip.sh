#!/usr/bin/env bash
#
# Experiment 1: what the service thinks a visitor's address is, behind a proxy.
#
# This is the live risk of the whole phase. Analytics hashes the visitor address
# to count unique visitors, and the rate limiter keys on the same value, so a
# wrong address corrupts both in the same direction and neither reports an
# error while doing it.
#
# Three configurations, because one proves nothing on its own:
#
#   a. TRUST_PROXY_HOPS=0 behind a proxy. The service reads the socket address,
#      which is nginx. Every visitor in the world becomes one visitor.
#   b. TRUST_PROXY_HOPS=1, the correct value here. Two clients with two
#      addresses stay two visitors.
#   c. TRUST_PROXY_HOPS=1, with a client forging a left-hand X-Forwarded-For
#      entry. It must not be able to choose its own identity.
#
# Unique visitors are counted as distinct ip_hash values in click_events. The
# raw address is never stored, so the digest is the only observable, which is
# itself the point of ADR 0004.

cd "$(dirname "$0")/../.."
source scripts/experiments/lib.sh

# Sends one request from each of three clients that exist at the same time.
#
# Concurrency is required, not incidental. Three throwaway containers run one
# after another are handed the same address, because Docker frees it when the
# first exits and reuses it for the next. Running them sequentially therefore
# measures one visitor no matter how correct the service is, which is a broken
# experiment reporting a broken result.
three_concurrent_clients() {
  local target="$1"
  local pids=()
  for _ in 1 2 3; do
    docker run --rm --network "$NETWORK" curlimages/curl:8.11.1       -s -o /dev/null --retry 2 "$target" &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done
}

say "Experiment 1: client address resolution behind a proxy"

slug=$(make_link expone)

# --- a. Wrong hop count -----------------------------------------------------
say "1a. TRUST_PROXY_HOPS=0, which is wrong behind a proxy"
restart_apps_with_hops 0
reset_clicks

three_concurrent_clients "http://nginx/${slug}"
sleep 2

distinct_a=$(sql 'select count(distinct ip_hash) from click_events')
total_a=$(sql 'select count(*) from click_events')
observe "three clicks from three different container addresses"
observe "clicks recorded: ${total_a}"
observe "distinct visitors recorded: ${distinct_a}   <- expected 1, every visitor collapsed into the proxy"

# --- b. Correct hop count ---------------------------------------------------
say "1b. TRUST_PROXY_HOPS=1, the correct value for one proxy"
restart_apps_with_hops 1
reset_clicks

three_concurrent_clients "http://nginx/${slug}"
sleep 2

distinct_b=$(sql 'select count(distinct ip_hash) from click_events')
total_b=$(sql 'select count(*) from click_events')
observe "three clicks from three different container addresses"
observe "clicks recorded: ${total_b}"
observe "distinct visitors recorded: ${distinct_b}   <- expected 3, one per real client"

# --- c. A client forging the header ----------------------------------------
say "1c. TRUST_PROXY_HOPS=1, with the client forging X-Forwarded-For"
reset_clicks

# One container, so one real address, sending three different forged left-hand
# entries. If forging worked, this would read as three visitors.
docker run --rm --network "$NETWORK" curlimages/curl:8.11.1 -s \
  -H 'X-Forwarded-For: 203.0.113.1' -o /dev/null "http://nginx/${slug}" \
  --next -s -H 'X-Forwarded-For: 203.0.113.2' -o /dev/null "http://nginx/${slug}" \
  --next -s -H 'X-Forwarded-For: 203.0.113.3' -o /dev/null "http://nginx/${slug}" || true
sleep 2

distinct_c=$(sql 'select count(distinct ip_hash) from click_events')
total_c=$(sql 'select count(*) from click_events')
observe "three clicks from ONE container, each forging a different address"
observe "clicks recorded: ${total_c}"
observe "distinct visitors recorded: ${distinct_c}   <- expected 1, the forged entries were ignored"

say "Result"
observe "1a distinct=${distinct_a}  1b distinct=${distinct_b}  1c distinct=${distinct_c}"
