#!/usr/bin/env bash
# Authoritative integration gate: run every contract AND e2e spec file against its OWN
# fresh SQLite DB. Specs are tenant-scoped and independent; a shared parallel DB only
# causes fixture-id collisions across suites (not a product bug), so we isolate per
# file. `npm run build` already proves the modules compose in app.module.ts.
set -u
cd "$(dirname "$0")/.."
fail=0
pass=0
specs=$(find src test \( -name '*.contract.spec.ts' -o -name '*.e2e-spec.ts' \) | sort)
for spec in $specs; do
  db="/tmp/oweme-ci-$(echo "$spec" | tr '/.' '--').db"
  rm -f "$db" "$db-journal"
  if OWEME_TEST_DB="$db" npx jest --config test/jest-e2e.json "$spec" >/tmp/ci-out-$$ 2>&1; then
    line=$(grep -E "Tests:" /tmp/ci-out-$$ | tail -1)
    echo "PASS  $spec    $line"
    pass=$((pass+1))
  else
    echo "FAIL  $spec"
    tail -25 /tmp/ci-out-$$
    fail=$((fail+1))
  fi
  rm -f "$db" "$db-journal"
done
rm -f /tmp/ci-out-$$
echo "----------------------------------------"
echo "Suites: $pass passed, $fail failed"
exit $fail
