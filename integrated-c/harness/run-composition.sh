#!/usr/bin/env bash
# Casos E1.2–E1.4 da avaliacao integrada de C: roda a spec e2e da sonda de
# composicao (apps/api/test/e2e/integrated-c) contra o curador real de C e o
# simulador de roteiro da pilha. O Postgres e o testcontainer do e2e.
#
# Uso: integrated-C/run-composition.sh <dir-saida>
# Requer: stack/up.sh C no ar; Docker (testcontainers).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
OUT="$(realpath -m "${1:?uso: $0 <dir-saida>}")"
STATE="$EXP/stack/run/C/stack.env"
[ -f "$STATE" ] || { echo "pilha C fora do ar ($STATE ausente)" >&2; exit 1; }
get() { grep "^$1=" "$STATE" | cut -d= -f2-; }

# shellcheck source=/dev/null
source "$EXP/stack/env.sh"
stack_vars C
mkdir -p "$OUT"
cd "$WORKTREE/apps/api"
# Retentativa SO para falha de infraestrutura antes dos testes (o testcontainer
# do globalSetup nao sobe): sem composition-summary.json nao houve caso
# executado. Falha de caso nunca e repetida. Cada tentativa fica registrada.
status=1
for attempt in 1 2 3; do
  rm -f "$OUT/composition-summary.json"
  set +e
  INTEGRATED_C=1 INTEGRATED_C_OUT="$OUT" TZ=UTC \
    MOCK_OPENROUTER_URL="$(get MOCK_OPENROUTER_URL)" \
    CURATOR_BASE_URL="$(get CURATOR_URL)" \
    CURATOR_SERVICE_SECRET="$(get CURATOR_SERVICE_SECRET)" \
    ./node_modules/.bin/jest --config ./test/jest-e2e.json \
      --runTestsByPath test/e2e/integrated-c/composition.e2e-spec.ts \
      --json --outputFile="$OUT/jest-composition.json" >"$OUT/jest-composition.attempt-$attempt.log" 2>&1
  status=$?
  set -e
  if [ -f "$OUT/composition-summary.json" ]; then
    echo "tentativa $attempt: casos executados (jest exit $status)" >>"$OUT/attempts.txt"
    cp "$OUT/jest-composition.attempt-$attempt.log" "$OUT/jest-composition.log"
    break
  fi
  echo "tentativa $attempt: falha de infraestrutura antes dos casos (jest exit $status)" >>"$OUT/attempts.txt"
  sleep 5
done
cat "$OUT/jest-composition.log" 2>/dev/null || cat "$OUT/jest-composition.attempt-$attempt.log"
exit "$status"
