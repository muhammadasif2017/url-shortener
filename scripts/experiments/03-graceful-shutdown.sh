#!/usr/bin/env bash
#
# Experiment 3: does a rolling restart drop requests?
#
# ADR 0005 lists this as the third thing a second instance breaks. Without
# graceful shutdown, stopping an instance severs whatever it was serving, and
# the caller sees a connection reset rather than a response. The service already
# implements the drain sequence in src/shutdown.ts, so the prediction is that
# nothing is dropped.
#
# Method: send a steady stream of requests through the proxy while one instance
# is sent SIGTERM, then count how many failed to produce an HTTP status at all.
# A 502 or a reset is a failure. A 200 or a 302 is not.

cd "$(dirname "$0")/../.."
source scripts/experiments/lib.sh

say "Experiment 3: stopping one instance under load"

slug=$(make_link expthree)

total=0
ok=0
failed=0
failure_codes=""

# Sent in the background so the stop lands in the middle of the run rather than
# before or after it.
(
  sleep 2
  $COMPOSE stop -t 20 app1 >/dev/null 2>&1
) &
stopper=$!

end=$((SECONDS + 8))
while [ $SECONDS -lt $end ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/${slug}" || echo "000")
  total=$((total + 1))
  case "$code" in
    302 | 200) ok=$((ok + 1)) ;;
    *)
      failed=$((failed + 1))
      failure_codes="${failure_codes} ${code}"
      ;;
  esac
done

wait "$stopper" || true

observe "requests sent while one instance was stopped: ${total}"
observe "successful: ${ok}"
observe "failed: ${failed}${failure_codes:+ (codes:${failure_codes})}"

if [ "$failed" -eq 0 ]; then
  observe "RESULT: no request was dropped. The instance drained before exiting, and"
  observe "        nginx moved traffic to the survivor."
else
  observe "RESULT: ${failed} request(s) were dropped. Graceful shutdown is not covering this."
fi

say "Bringing the stopped instance back"
$COMPOSE start app1 >/dev/null 2>&1
wait_for_ready
observe "app1 is serving again"
