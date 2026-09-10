# Shared helpers for the multi-instance experiments.
#
# Sourced, never executed. Every experiment prints what it is about to do, does
# it, and prints what was observed, because the deliverable of this phase is a
# record of what happened rather than a pass or fail.

set -euo pipefail

COMPOSE="docker compose -f docker-compose.multi.yml"
BASE="http://127.0.0.1:8080"

# The Compose network, for running a client from inside it. A client on the
# network gets its own address, which is the only way to produce two visitors
# that the proxy can tell apart.
NETWORK="url-shortener-multi_default"

# Prints a heading.
say() {
  printf '\n\033[1m%s\033[0m\n' "$*"
}

# Prints an observation, which is what ends up in the written record.
observe() {
  printf '  %s\n' "$*"
}

# Runs SQL against the experiment database and prints the bare result.
sql() {
  $COMPOSE exec -T postgres psql -U postgres -d urlshortener -tAc "$1"
}

# Runs curl from a throwaway container on the Compose network, so the request
# arrives with an address of its own rather than the host's.
curl_from_network() {
  docker run --rm --network "$NETWORK" curlimages/curl:8.11.1 -s "$@"
}

# Empties the click table, so a count means only what this experiment produced.
reset_clicks() {
  sql 'truncate table click_events' >/dev/null
}

# Brings both application instances back up with a given trusted hop count.
#
# The value reaches the containers through docker-compose.multi.yml, which reads
# TRUST_PROXY_HOPS from the host environment and defaults it to 1.
restart_apps_with_hops() {
  local hops="$1"
  TRUST_PROXY_HOPS="$hops" $COMPOSE up -d --force-recreate app1 app2 >/dev/null 2>&1
  wait_for_ready
}

# Blocks until the stack answers, so an experiment never measures a cold start.
wait_for_ready() {
  local attempt=0
  until curl -s -o /dev/null -w '%{http_code}' "$BASE/health/ready" | grep -q 200; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 30 ]; then
      echo "stack did not become ready" >&2
      exit 1
    fi
    sleep 1
  done
}

# Creates a link directly in the database and prints its slug. Going through the
# API would need an account, and none of these experiments are about that.
make_link() {
  local slug="$1"
  sql "insert into links (slug, url, created_at) values ('${slug}', 'https://example.com/${slug}', now())
       on conflict (slug) do nothing" >/dev/null
  printf '%s' "$slug"
}
