#!/usr/bin/env bash
#
# Experiment 2: does the credential limit survive a second instance?
#
# This is the failure ADR 0002 shipped with and ADR 0007 fixed. An in-memory
# counter is per instance, so two instances keep two counters and the effective
# limit doubles. A sign-in limit that multiplies by instance count is not a
# limit, which is why the API counters were moved into Postgres.
#
# The prediction is therefore that nothing doubles. Round robin sends
# consecutive attempts to alternating instances, and the eleventh must be
# refused even though neither instance has seen eleven.
#
# The limit under test is 10 per 15 minutes, set in src/server.ts.

cd "$(dirname "$0")/../.."
source scripts/experiments/lib.sh

say "Experiment 2: credential rate limit across two instances"

# Every attempt is a failed sign-in for an account that does not exist. The
# limit counts attempts against the address, so the credentials being wrong is
# irrelevant to what is being measured.
attempt() {
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$BASE/api/auth/login" \
    -H 'content-type: application/json' \
    -d '{"email":"nobody@example.com","password":"a sufficiently long passphrase"}'
}

sql "delete from rate_limit_windows" >/dev/null

refused_at=0
statuses=""
for i in $(seq 1 12); do
  code=$(attempt)
  statuses="${statuses} ${code}"
  if [ "$code" = "429" ] && [ "$refused_at" -eq 0 ]; then
    refused_at=$i
  fi
done

observe "statuses in order:${statuses}"
observe "first refusal at attempt: ${refused_at}   <- expected 11, the limit is 10"

# How the attempts were spread. If they all landed on one instance the result
# would be meaningless, so this is part of the evidence rather than a detail.
app1_hits=$($COMPOSE logs nginx 2>/dev/null | grep -c 'auth/login.*' || true)
observe "requests seen by nginx for /api/auth/login: ${app1_hits} (round robin, so roughly half to each instance)"

if [ "$refused_at" -eq 11 ]; then
  observe "RESULT: the limit held at 10 across both instances. The shared counter works."
elif [ "$refused_at" -eq 0 ]; then
  observe "RESULT: never refused in 12 attempts. The limit is not being enforced."
else
  observe "RESULT: refused at ${refused_at}, which is not the configured limit of 10."
fi
