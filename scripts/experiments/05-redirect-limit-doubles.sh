#!/usr/bin/env bash
#
# Experiment 5: the redirect limit doubles, and that is the accepted cost.
#
# ADR 0007 moved the API counters into Postgres and deliberately left the
# redirect path counting in process memory. What that limit protects is the
# database from click-write amplification, and paying a synchronous round trip
# to that database in order to protect it would be self-defeating. The accepted
# consequence is that the cap is per instance, so N instances allow N times the
# traffic.
#
# This experiment confirms the cost rather than finding a bug. A decision whose
# stated downside has never been observed is a decision nobody has checked.
#
# The limit is 600 per minute per instance, set in src/server.ts.

cd "$(dirname "$0")/../.."
source scripts/experiments/lib.sh

say "Experiment 5: redirect limit with one instance and with two"

slug=$(make_link expfive)

# Sends N requests from one container, reusing the connection, and prints how
# many were refused. One container means one address, which is what the limiter
# keys on.
flood() {
  local target="$1" count="$2"
  local urls=""
  for _ in $(seq 1 "$count"); do
    urls="${urls} ${target}"
  done

  # The status is printed on a line of its OWN, and the leading newline is the
  # whole point. In multi-URL mode `-o /dev/null` applies to the FIRST url only,
  # so every later response body lands on stdout and runs straight into the
  # status that follows it. Counting '^429$' against that output reports zero
  # refusals however many there were, which is exactly how this experiment first
  # produced a wrong answer.
  #
  # shellcheck disable=SC2086
  docker run --rm --network "$NETWORK" curlimages/curl:8.11.1 \
    -s -o /dev/null -w '\n%{http_code}\n' $urls 2>/dev/null | grep -c '^429$' || true
}

# The counters live in process memory, so a restart is the only way to clear
# them. Doing it before 5a as well as between the halves keeps the result
# independent of whatever ran before this script.
say "Restarting both instances so the counters start empty"
$COMPOSE restart app1 app2 >/dev/null 2>&1
wait_for_ready

say "5a. 700 requests to ONE instance, bypassing the proxy"
observe "sending..."
refused_single=$(flood "http://app1:3000/${slug}" 700)
observe "refused with 429: ${refused_single}   <- expected about 100, the cap is 600"

# The in-memory counter is per process, so it has to be cleared between the two
# halves. Restarting is the only way to clear it, which is itself a property of
# the design worth seeing.
say "Restarting both instances to clear the in-memory counters"
$COMPOSE restart app1 app2 >/dev/null 2>&1
wait_for_ready

say "5b. 700 requests through the proxy, spread across TWO instances"
observe "sending..."
refused_pair=$(flood "http://nginx/${slug}" 700)
observe "refused with 429: ${refused_pair}   <- expected 0, each instance saw only about 350"

say "Result"
observe "one instance refused ${refused_single} of 700"
observe "two instances refused ${refused_pair} of 700"

if [ "$refused_single" -gt 0 ] && [ "$refused_pair" -eq 0 ]; then
  observe "RESULT: the cap doubled, exactly as ADR 0007 says it does. Traffic that one"
  observe "        instance refuses, two instances accept. This is the accepted cost of"
  observe "        keeping the hot path off the database, not a defect."
else
  observe "RESULT: unexpected. single=${refused_single} pair=${refused_pair}"
fi
