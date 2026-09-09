#!/bin/sh
# PERF0 baseline campaign: 3 matched sequential runs of all three tools.
# Usage: sh scripts/benchmark/run-campaign.sh <output-dir>
# Run from the repository root with production assets built first:
#   npm run build:ui && npm run build:ui:profiling
# Nothing else may run on the machine (a concurrent benchmark contaminates timing).
OUT="$1"
[ -n "$OUT" ] || { echo "usage: run-campaign.sh <output-dir>"; exit 2; }
mkdir -p "$OUT" || exit 1
{
  echo "commit: $(git rev-parse HEAD)"
  echo "node: $(node -v)"
  echo "npm: $(npm -v)"
  node -e "const db=require('better-sqlite3')(':memory:');console.log('sqlite:',db.prepare('select sqlite_version() v').get().v)"
  node -e "console.log('tsx:', require('tsx/package.json').version)"
  node -e "console.log('better-sqlite3:', require('better-sqlite3/package.json').version)"
  echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT/metadata.txt"
for run in 1 2 3; do
  echo "=== run $run history $(date -u +%H:%M:%SZ) ==="
  npx --no-install tsx scripts/benchmark/synthetic-history.ts > "$OUT/run$run-history.json" 2> "$OUT/run$run-history.err"
  echo "history exit $?"
  [ -s "$OUT/run$run-history.json" ] || { echo "STEP_FAILED history run $run"; cat "$OUT/run$run-history.err"; exit 1; }
  echo "=== run $run browser $(date -u +%H:%M:%SZ) ==="
  npx --no-install tsx scripts/benchmark/browser-measure.ts > "$OUT/run$run-browser.json" 2> "$OUT/run$run-browser.err"
  echo "browser exit $?"
  grep -q '"scales"' "$OUT/run$run-browser.json" || { echo "STEP_FAILED browser run $run"; cat "$OUT/run$run-browser.err"; exit 1; }
  echo "=== run $run esf $(date -u +%H:%M:%SZ) ==="
  npx --no-install tsx scripts/benchmark/esf-observation-measure.ts > "$OUT/run$run-esf.json" 2> "$OUT/run$run-esf.err" || true
done
echo "finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT/metadata.txt"
echo CAMPAIGN_COMPLETE
