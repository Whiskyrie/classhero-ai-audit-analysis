#!/usr/bin/env bash
# Pacote de evidencias da avaliacao integrada de C (E1 e E2), de ponta a ponta.
# Para cada execucao: derruba e sobe a pilha C do zero, roda o caminho publico
# (E1.1, E1.5, E2), a sonda de composicao (E1.2-E1.4) e o controle negativo,
# coleta as saidas brutas e derruba a pilha. Ao fim gera QUADRO.md e confere
# determinismo entre execucoes.
#
# Uso: integrated-C/run-all.sh [N_EXECUCOES=2] [DIR_SAIDA]
# Requer: Docker, psql, Node >= 22, worktree C com API compilada e curador release.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
N="${1:-2}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$(realpath -m "${2:-$EXP/results/integrated-C/$STAMP}")"
# shellcheck source=/dev/null
source "$EXP/stack/env.sh"
stack_vars C
mkdir -p "$OUT"

# ── Proveniencia (sem segredos) ──────────────────────────────────────────────
{
  echo "{"
  echo "  \"gerado_em\": \"$STAMP\","
  echo "  \"execucoes\": $N,"
  echo "  \"classhero_commit_C\": \"$(git -C "$WORKTREE" rev-parse HEAD)\","
  echo "  \"classhero_branch_C\": \"$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD)\","
  echo "  \"classhero_worktree_limpo\": $( [ -z "$(git -C "$WORKTREE" status --porcelain)" ] && echo true || echo false ),"
  echo "  \"artigo_commit\": \"$(git -C "$EXP" rev-parse HEAD 2>/dev/null || echo n/a)\","
  echo "  \"node\": \"$(node --version)\","
  echo "  \"psql\": \"$(psql --version | awk '{print $3}')\","
  echo "  \"docker\": \"$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo n/a)\","
  echo "  \"postgres_imagem\": \"$PG_IMAGE\","
  echo "  \"curador_binario_sha256\": \"$(sha256sum "$WORKTREE/services/content-curator/target/release/content-curator" | cut -c1-64)\","
  echo "  \"simulador_sha256\": \"$(sha256sum "$EXP/mock-openrouter/server.js" | cut -c1-64)\""
  echo "}"
} >"$OUT/proveniencia.json"
( cd "$HERE" && sha256sum run-all.sh run-public.mjs run-composition.sh run-mutant-control.sh build-report.mjs lib/common.mjs ) >"$OUT/scripts.sha256"
( cd "$WORKTREE/apps/api" && sha256sum test/e2e/integrated-c/*.ts ) >>"$OUT/scripts.sha256"

# ── Testes do simulador ──────────────────────────────────────────────────────
( cd "$EXP/mock-openrouter" && node --test server.test.js ) >"$OUT/mock-openrouter-tests.txt" 2>&1 \
  || { echo "testes do simulador falharam; ver $OUT/mock-openrouter-tests.txt" >&2; exit 1; }

for i in $(seq 1 "$N"); do
  R="$OUT/run-$i"
  echo "== execucao $i/$N -> $R"
  PAPER_SKIP_DUMP=yes "$EXP/stack/down.sh" C >/dev/null 2>&1 || true
  "$EXP/stack/up.sh" C >"$R.up.log" 2>&1 || { echo "falha ao subir a pilha; ver $R.up.log" >&2; exit 1; }
  mkdir -p "$R"
  mv "$R.up.log" "$R/stack-up.log"
  set +e
  node "$HERE/run-public.mjs" --out "$R/public" >"$R/public.txt" 2>&1; echo "public=$?" >>"$R/exit-codes.txt"
  "$HERE/run-composition.sh" "$R/composition" >/dev/null 2>&1; echo "composition=$?" >>"$R/exit-codes.txt"
  "$HERE/run-mutant-control.sh" "$R/mutant" >"$R/mutant.txt" 2>&1; echo "mutant=$?" >>"$R/exit-codes.txt"
  set -e
  # Logs do curador e da API desta execucao (sem segredos: so stdout dos processos).
  LATEST="$(ls -td "$EXP/stack/logs/C-"* | head -1)"
  cp "$LATEST/curator.log" "$LATEST/api.log" "$R/" 2>/dev/null || true
  PAPER_SKIP_DUMP=yes "$EXP/stack/down.sh" C >/dev/null 2>&1 || true
done

git -C "$WORKTREE" status --porcelain >"$OUT/worktree-status-final.txt"
node "$HERE/build-report.mjs" "$OUT"
echo "pacote: $OUT"
