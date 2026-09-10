#!/usr/bin/env bash
#
# Runs every multi-instance experiment in order, against a stack that must
# already be up:
#
#   docker compose -f docker-compose.multi.yml up -d --build
#   npm run experiments
#   docker compose -f docker-compose.multi.yml down -v
#
# Order matters in one place only: experiment 1 leaves the instances running
# with the correct trusted hop count, which everything after it assumes.
#
# These are experiments, not tests. They print what was observed and do not
# assert. A test tells you whether the code still does what it did; an
# experiment tells you what it does. Turning these into pass-or-fail assertions
# would lose the numbers, and the numbers are the deliverable.

cd "$(dirname "$0")/../.."
source scripts/experiments/lib.sh

wait_for_ready

for script in scripts/experiments/0*.sh; do
  bash "$script"
done

say "All experiments complete"
observe "The written record is docs/multi-instance.md."
observe "Tear the stack down with: docker compose -f docker-compose.multi.yml down -v"
