#!/usr/bin/env bash
#
# Experiment 4: what happens to both instances when the database goes away?
#
# This is the failure ADR 0008 was written to prevent. Before the split, one
# endpoint answered both questions, so a database outage would have failed the
# probe that triggers restarts. A restart does not repair an unreachable
# database, so every instance would have entered a restart loop at the moment
# the database was least able to absorb reconnections.
#
# The prediction after the split: readiness reports degraded, liveness keeps
# answering, and no container restarts.

cd "$(dirname "$0")/../.."
source scripts/experiments/lib.sh

say "Experiment 4: database outage, with liveness and readiness split"

restarts_before=$(docker inspect -f '{{.RestartCount}}' url-shortener-multi-app1-1)
observe "app1 restart count before: ${restarts_before}"

say "Stopping the database"
$COMPOSE stop postgres >/dev/null 2>&1

# The readiness query is bounded at two seconds, so this is enough for both
# probes to have answered under the outage.
sleep 6

live=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/health/live" || echo "000")
ready_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/health/ready" || echo "000")
ready_body=$(curl -s --max-time 10 "$BASE/health/ready" || echo "no response")

observe "GET /health/live  -> ${live}   <- expected 200, the process is fine"
observe "GET /health/ready -> ${ready_code}   <- expected 503, the dependency is not"
observe "readiness body: ${ready_body}"

# A redirect needs the database, so it should fail while the outage lasts. This
# is included to show readiness is reporting something true rather than
# guessing.
redirect=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/expthree" || echo "000")
observe "GET /expthree     -> ${redirect}   <- the product is genuinely unavailable"

restarts_during=$(docker inspect -f '{{.RestartCount}}' url-shortener-multi-app1-1)
observe "app1 restart count during outage: ${restarts_during}"

say "Restoring the database"
$COMPOSE start postgres >/dev/null 2>&1
wait_for_ready

recovered=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/ready")
observe "GET /health/ready -> ${recovered} after recovery, with no restart and no redeploy"

if [ "$live" = "200" ] && [ "$ready_code" = "503" ] && [ "$restarts_during" = "$restarts_before" ]; then
  observe "RESULT: the split behaved as designed. An orchestrator reading liveness would"
  observe "        have left both containers alone, while a load balancer reading readiness"
  observe "        would have taken them out of rotation."
else
  observe "RESULT: unexpected. live=${live} ready=${ready_code} restarts=${restarts_before}->${restarts_during}"
fi
