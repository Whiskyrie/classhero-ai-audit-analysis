// Utilitarios da avaliacao integrada de C: controle do simulador (roteiro e
// livro-razao), consulta ao Postgres da pilha, scrape de metricas e escrita de
// saidas brutas. Sem dependencias externas (Node >= 22 e psql no PATH).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const round8 = (x) => Math.round(Number(x) * 1e8) / 1e8;
export const eq8 = (a, b) => a !== null && b !== null && Math.abs(Number(a) - Number(b)) < 5e-9;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Simulador ────────────────────────────────────────────────────────────────
export function mock(baseUrl) {
  const post = async (path, body) => {
    const r = await fetch(baseUrl + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
    return r.json();
  };
  return {
    reset: () => post('/_reset'),
    script: (marker, steps) => post('/_script', { marker, steps }),
    ledger: async () => (await (await fetch(baseUrl + '/_ledger')).json()).entries,
  };
}

// ── Postgres ─────────────────────────────────────────────────────────────────
export function psqlJson(dbUrl, sql) {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t`;
  const r = spawnSync('psql', [dbUrl, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', wrapped], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return JSON.parse(r.stdout.trim() || '[]');
}

export function psqlExec(dbUrl, sql) {
  const r = spawnSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
}

export const EVENT_COLUMNS = `event_id, occurred_at, action, route, success, request_id, generation_id,
  model_provider, model_name, prompt_tokens, completion_tokens, total_tokens,
  cost_usd::text AS cost_usd, estimated_cost_usd::text AS estimated_cost_usd,
  failed_attempts_cost_usd::text AS failed_attempts_cost_usd, attempt_count,
  usage_reported, error_code, course_name_snapshot`;

export function eventsByRequestIds(dbUrl, requestIds) {
  if (!requestIds.length) return [];
  const list = requestIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',');
  return psqlJson(dbUrl, `SELECT ${EVENT_COLUMNS} FROM audit.ai_usage_events WHERE request_id IN (${list}) ORDER BY occurred_at`);
}

// ── Metricas Prometheus (texto) ──────────────────────────────────────────────
export async function scrape(url) {
  const txt = await (await fetch(url)).text();
  const out = {};
  for (const line of txt.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)/);
    if (!m) continue;
    const key = m[1] + (m[2] || '');
    out[key] = Number(m[3]);
  }
  return out;
}

/** Soma (depois - antes) de todas as series cujo nome e `name`, opcionalmente filtrando rotulos. */
export function delta(before, after, name, labelFilter = () => true) {
  let s = 0;
  for (const [k, v] of Object.entries(after)) {
    const [n, labels = ''] = k.split(/(?=\{)/);
    if (n !== name || !labelFilter(labels)) continue;
    s += v - (before[k] || 0);
  }
  return round8(s);
}

// ── Saidas ───────────────────────────────────────────────────────────────────
export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

/** Criterio avaliado: { id, descricao, esperado, observado, ok }. */
export function check(id, descricao, esperado, observado, ok) {
  return { id, descricao, esperado, observado, ok: Boolean(ok) };
}
