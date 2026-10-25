#!/usr/bin/env node
// Avaliacao integrada de C pelo caminho publico (HTTP -> API -> curador ->
// simulador -> Postgres). Casos E1.1 (concorrencia entre requisicoes), E1.5
// (controle sequencial) e E2.a-E2.e (conservacao de custo no evento, no
// relatorio administrativo e nas metricas).
//
// Uso: node integrated-C/run-public.mjs --out <dir>
// Requer a pilha C no ar (stack/up.sh C) com o simulador de roteiro.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSql } from '../load/seed.mjs';
import { login, readStackEnv, clientIp, readSse } from '../load/lib/http.mjs';
import {
  mock, psqlJson, psqlExec, eventsByRequestIds, scrape, delta, writeJson, check,
  round8, eq8, sleep, EVENT_COLUMNS,
} from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = resolve(HERE, '..');
const args = process.argv.slice(2);
const OUT = resolve(args[args.indexOf('--out') + 1] || `${HERE}/out/manual`);

const env = readStackEnv(EXP, 'C');
const M = mock(env.MOCK_OPENROUTER_URL);
const DB = env.DATABASE_URL;
const API = env.API_URL;

// ── Contas sinteticas (mesma semente da carga; ids >= 900 reservados aqui) ──
const TEACHER = { n: 901, role: 'teacher', email: 'load-user-901@paper.test', name: 'Prof Sonda C' };
const ADMIN = { n: 902, role: 'admin', email: 'load-user-902@paper.test', name: 'Admin Sonda C' };

function seed() {
  const r = spawnSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-q', '-X', '-f', '-'], {
    input: buildSql([TEACHER, ADMIN], 'carga-sintetica-paper'), encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

// ── Chamadas publicas, cada uma com x-request-id proprio ────────────────────
// Cada chamada sai de um IP sintetico distinto (x-forwarded-for, trust proxy=1):
// o limite por IP das rotas de IA (5/min em SSE) nao entra no experimento.
let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `10.99.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; };
async function call(token, _ip, path, body, { sse = false } = {}) {
  const ip = nextIp();
  const requestId = randomUUID();
  const t0 = performance.now();
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': ip, 'x-request-id': requestId },
    body: JSON.stringify(body),
  });
  let payload;
  if (sse) {
    const evs = await readSse(res);
    payload = { events: evs.map((e) => e.event), last: evs.at(-1)?.data?.slice(0, 200) ?? null };
  } else {
    payload = (await res.text()).slice(0, 300);
  }
  return {
    requestId, echoed: res.headers.get('x-request-id'), status: res.status,
    ms: Math.round(performance.now() - t0), payload,
  };
}

const badge = (ctx, marker) => call(ctx.token, ctx.ip, `/courses/${ctx.courseId}/missions/badge/title/suggest`, {
  missionTitle: `Missao sonda [[probe:${marker}]]`, courseName: ctx.courseName,
});
const description = (ctx, marker) => call(ctx.token, ctx.ip, '/courses/ai/description/stream', {
  courseName: `Curso sonda [[probe:${marker}]]`, isIndividual: true, hasClasses: false, hasDisciplines: false, withReferences: false,
}, { sse: true });

// ── Oraculo: cruza evento x livro-razao x requisicao enviada ────────────────
function matchEvents(sent, events, ledger) {
  const byGen = new Map(ledger.map((e) => [e.generation_id, e]));
  return sent.map((s) => {
    const ev = events.filter((e) => e.request_id === s.requestId);
    const mine = ledger.filter((l) => l.marker === s.marker);
    const final = mine.at(-1) ?? null; // ultima tentativa do proprio marcador
    const e = ev.at(-1) ?? null;
    const led = e && byGen.get(e.generation_id);
    return {
      marker: s.marker, flow: s.flow, request_id: s.requestId, http_status: s.status,
      events_for_request: ev.length,
      event_generation_id: e?.generation_id ?? null,
      ledger_marker_of_event_generation: led?.marker ?? null,
      expected_final_cost: final ? final.reported_cost_usd : null,
      expected_failed_cost: round8(mine.slice(0, -1).reduce((a, l) => a + (l.reported_cost_usd ?? 0), 0)),
      observed_cost_usd: e?.cost_usd ?? null,
      observed_failed_cost_usd: e?.failed_attempts_cost_usd ?? null,
      observed_attempt_count: e?.attempt_count ?? null,
      ledger_attempts: mine.length,
      finish_seq: final?.finish_seq ?? null,
    };
  });
}

const identityOk = (r) =>
  r.events_for_request === 1 &&
  r.ledger_marker_of_event_generation === r.marker &&
  (r.expected_final_cost === null ? r.observed_cost_usd === null : eq8(r.observed_cost_usd, r.expected_final_cost));

// ── Casos ────────────────────────────────────────────────────────────────────
async function caseE11(ctx) {
  // 5 requisicoes simultaneas, partidas escalonadas em 40 ms; atrasos
  // invertidos fazem a ultima a sair terminar primeiro. Custos distintos.
  await M.reset();
  const plan = [
    { marker: 'e11a', flow: 'badge', cost: 0.01011, delay_ms: 900 },
    { marker: 'e11b', flow: 'description', cost: 0.02022, delay_ms: 700 },
    { marker: 'e11c', flow: 'badge', cost: 0.03033, delay_ms: 500 },
    { marker: 'e11d', flow: 'description', cost: 0.04044, delay_ms: 300 },
    { marker: 'e11e', flow: 'badge', cost: 0.05055, delay_ms: 0 },
  ];
  for (const p of plan) await M.script(p.marker, [{ cost: p.cost, delay_ms: p.delay_ms }]);
  const sent = await Promise.all(plan.map(async (p, i) => {
    await sleep(i * 40);
    const r = await (p.flow === 'badge' ? badge(ctx, p.marker) : description(ctx, p.marker));
    return { ...p, ...r, startIdx: i };
  }));
  await sleep(300);
  return finishCase('E1.1', 'Concorrencia entre requisicoes publicas, termino invertido', plan, sent, {
    expectReversed: true,
  });
}

async function caseE15(ctx) {
  await M.reset();
  const plan = [
    { marker: 'e15a', flow: 'badge', cost: 0.00111 },
    { marker: 'e15b', flow: 'description', cost: 0.00222 },
    { marker: 'e15c', flow: 'badge', cost: 0.00333 },
  ];
  for (const p of plan) await M.script(p.marker, [{ cost: p.cost }]);
  const sent = [];
  for (const p of plan) sent.push({ ...p, ...(await (p.flow === 'badge' ? badge(ctx, p.marker) : description(ctx, p.marker))) });
  await sleep(300);
  return finishCase('E1.5', 'Controle sequencial (termino em ordem)', plan, sent, {});
}

async function finishCase(id, title, plan, sent, { expectReversed }) {
  const ledger = await M.ledger();
  const events = eventsByRequestIds(DB, sent.map((s) => s.requestId));
  const rows = matchEvents(sent, events, ledger);
  const checks = [
    check(`${id}-http`, 'todas as requisicoes responderam 2xx e ecoaram o x-request-id',
      'status 2xx; eco igual', sent.map((s) => `${s.marker}:${s.status}`).join(' '),
      sent.every((s) => s.status >= 200 && s.status < 300 && s.echoed === s.requestId)),
    check(`${id}-ident`, 'cada requisicao tem exatamente um evento, com o generation_id e o custo do proprio marcador',
      'trocas = 0', `trocas = ${rows.filter((r) => !identityOk(r)).length}`, rows.every(identityOk)),
  ];
  if (expectReversed) {
    const order = rows.slice().sort((a, b) => a.finish_seq - b.finish_seq).map((r) => r.marker);
    const expected = plan.map((p) => p.marker).reverse();
    checks.push(check(`${id}-ordem`, 'ordem de termino no provedor inversa a ordem de partida',
      expected.join(','), order.join(','), order.join(',') === expected.join(',')));
  }
  const result = { id, title, ok: checks.every((c) => c.ok), checks, rows };
  writeJson(`${OUT}/${id}/sent.json`, sent);
  writeJson(`${OUT}/${id}/ledger.json`, ledger);
  writeJson(`${OUT}/${id}/events.json`, events);
  writeJson(`${OUT}/${id}/result.json`, result);
  return result;
}

async function caseE2(ctx, adminToken) {
  // Janela limpa: o relatorio e lido sobre todo o periodo, entao o caso
  // zera a tabela de eventos da pilha experimental antes de comecar.
  psqlExec(DB, 'TRUNCATE audit.ai_usage_events;');
  await M.reset();
  const apiBefore = await scrape(`${API}/metrics`);
  const curBefore = await scrape(`${env.CURATOR_URL}/metrics`);

  const plan = [
    { sub: 'E2.a', marker: 'e2a', flow: 'badge', steps: [{ mode: 'ok', cost: 0.0311 }], kind: 'conhecido' },
    { sub: 'E2.b', marker: 'e2b', flow: 'badge', steps: [{ mode: 'decode_error_charged', cost: 0.0122 }, { mode: 'ok', cost: 0.0344 }], kind: 'retry cobrado' },
    { sub: 'E2.c', marker: 'e2c', flow: 'badge', steps: [{ mode: 'no_usage', cost: 0.0177 }], kind: 'desconhecido (texto)' },
    { sub: 'E2.d', marker: 'e2d', flow: 'badge', steps: [{ mode: 'free_cost_zero' }], kind: 'zero real' },
    { sub: 'E2.e', marker: 'e2e', flow: 'description', steps: [{ mode: 'no_usage', cost: 0.0199 }], kind: 'desconhecido (SSE)' },
  ];
  for (const p of plan) await M.script(p.marker, p.steps);
  const sent = [];
  for (const p of plan) sent.push({ ...p, ...(await (p.flow === 'badge' ? badge(ctx, p.marker) : description(ctx, p.marker))) });
  await sleep(500);

  const ledger = await M.ledger();
  const events = eventsByRequestIds(DB, sent.map((s) => s.requestId));
  const allEvents = psqlJson(DB, `SELECT ${EVENT_COLUMNS} FROM audit.ai_usage_events ORDER BY occurred_at`);
  const rows = matchEvents(sent, events, ledger);
  const apiAfter = await scrape(`${API}/metrics`);
  const curAfter = await scrape(`${env.CURATOR_URL}/metrics`);
  const report = await (await fetch(`${API}/admin/ai-costs?period=all`, { headers: { authorization: `Bearer ${adminToken}` } })).json();

  // Oraculo: so o simulador sabe o custo cobrado; o informado e o que a
  // resposta trouxe. O relatorio so pode chegar ao informado.
  const billed = round8(ledger.reduce((a, l) => a + l.billed_cost_usd, 0));
  const reported = round8(ledger.reduce((a, l) => a + (l.reported_cost_usd ?? 0), 0));
  const unknownExpected = plan.filter((p) => p.steps.at(-1).mode === 'no_usage').length;
  const freeExpected = plan.filter((p) => p.steps.at(-1).mode === 'free_cost_zero').length;
  const s = report.summary || {};
  const byModelSum = round8((report.breakdownByModel || []).reduce((a, m) => a + Number(m.costInUsd), 0));
  const r = Object.fromEntries(rows.map((x) => [x.marker, x]));

  const checks = [
    check('E2-http', 'todas as chamadas responderam 2xx', '2xx', sent.map((x) => `${x.marker}:${x.status}`).join(' '),
      sent.every((x) => x.status >= 200 && x.status < 300)),
    check('E2.a-evento', 'custo conhecido gravado igual ao servido', '0.0311', r.e2a.observed_cost_usd, eq8(r.e2a.observed_cost_usd, 0.0311)),
    check('E2.b-evento', 'retry: final em cost_usd, anterior em failed_attempts_cost_usd, 2 tentativas',
      'cost=0.0344 failed=0.0122 attempts=2',
      `cost=${r.e2b.observed_cost_usd} failed=${r.e2b.observed_failed_cost_usd} attempts=${r.e2b.observed_attempt_count}`,
      eq8(r.e2b.observed_cost_usd, 0.0344) && eq8(r.e2b.observed_failed_cost_usd, 0.0122) && r.e2b.observed_attempt_count === 2),
    check('E2.c-evento', 'texto sem usage: custo NULL (desconhecido), nao zero', 'cost=NULL',
      `cost=${r.e2c.observed_cost_usd}`, r.e2c.events_for_request === 1 && r.e2c.observed_cost_usd === null),
    check('E2.d-evento', 'zero real gravado como 0', 'cost=0', `cost=${r.e2d.observed_cost_usd}`, eq8(r.e2d.observed_cost_usd, 0)),
    check('E2.e-evento', 'SSE sem usage: custo NULL (desconhecido)', 'cost=NULL',
      `cost=${r.e2e.observed_cost_usd}`, r.e2e.events_for_request === 1 && r.e2e.observed_cost_usd === null),
    check('E2-eventos', 'um evento por operacao (sem dupla contagem da tentativa final)', `${plan.length}`, `${allEvents.length}`,
      allEvents.length === plan.length),
    check('E2-rel-total', 'relatorio: totalCostInUsd = soma do custo informado (inclui tentativa anterior cobrada)',
      `${reported}`, `${s.totalCostInUsd}`, eq8(s.totalCostInUsd, reported)),
    check('E2-rel-desconhecido', 'relatorio: unknownCostRequests = operacoes sem custo final', `${unknownExpected}`,
      `${s.unknownCostRequests}`, s.unknownCostRequests === unknownExpected),
    check('E2-rel-gratis', 'relatorio: freeRequests conta so o zero real (desconhecido nao vira gratuito)', `${freeExpected}`,
      `${s.freeRequests}`, s.freeRequests === freeExpected),
    check('E2-rel-completo', 'relatorio: total so pode ser lido como completo se unknownCostRequests = 0; aqui deve sinalizar incompleto',
      'unknownCostRequests > 0 e total < cobrado', `unknown=${s.unknownCostRequests} total=${s.totalCostInUsd} cobrado=${billed}`,
      s.unknownCostRequests > 0 && Number(s.totalCostInUsd) < billed),
    check('E2-rel-modelo', 'relatorio: soma por modelo = totalCostInUsd', `${s.totalCostInUsd}`, `${byModelSum}`,
      eq8(byModelSum, s.totalCostInUsd)),
    check('E2-met-api-custo', 'metrica API: delta de ai_cost_usd_total = custo informado', `${reported}`,
      `${delta(apiBefore, apiAfter, 'ai_cost_usd_total')}`, eq8(delta(apiBefore, apiAfter, 'ai_cost_usd_total'), reported)),
    check('E2-met-api-desconhecido', 'metrica API: delta de ai_cost_unknown_total = operacoes sem custo final', `${unknownExpected}`,
      `${delta(apiBefore, apiAfter, 'ai_cost_unknown_total')}`, delta(apiBefore, apiAfter, 'ai_cost_unknown_total') === unknownExpected),
    check('E2-met-curador', 'metrica curador: delta de curator_ai_cost_usd_total = custo informado', `${reported}`,
      `${delta(curBefore, curAfter, 'curator_ai_cost_usd_total')}`, eq8(delta(curBefore, curAfter, 'curator_ai_cost_usd_total'), reported)),
  ];

  // E2.f: janela so com custo desconhecido. Isola o `isFree` por modelo, que no
  // roteiro misto e verdadeiro de qualquer forma por causa do zero real (E2.d).
  psqlExec(DB, 'TRUNCATE audit.ai_usage_events;');
  await M.script('e2f', [{ mode: 'no_usage', cost: 0.0155 }]);
  const onlyUnknown = await badge(ctx, 'e2f');
  await sleep(300);
  const reportF = await (await fetch(`${API}/admin/ai-costs?period=all`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
  const fModels = reportF.breakdownByModel || [];
  checks.push(
    check('E2.f-rel-gratis', 'so desconhecido: freeRequests = 0 e unknownCostRequests = 1', 'free=0 unknown=1',
      `http=${onlyUnknown.status} free=${reportF.summary?.freeRequests} unknown=${reportF.summary?.unknownCostRequests}`,
      onlyUnknown.status === 200 && reportF.summary?.freeRequests === 0 && reportF.summary?.unknownCostRequests === 1),
    check('E2.f-rel-modelo-gratis', 'so desconhecido: isFree por modelo = false (desconhecido nao vira gratuito)', 'isFree=false',
      `isFree=${fModels.map((m) => m.isFree).join(',')}`, fModels.length === 1 && fModels[0].isFree === false),
  );
  writeJson(`${OUT}/E2/admin-ai-costs-only-unknown.json`, reportF);

  const result = {
    id: 'E2', title: 'Conservacao de custo: evento, relatorio e metricas', ok: checks.every((c) => c.ok),
    oracle: { billed_cost_usd: billed, reported_cost_usd: reported, unknown_operations: unknownExpected, free_operations: freeExpected },
    checks, rows,
  };
  writeJson(`${OUT}/E2/sent.json`, sent);
  writeJson(`${OUT}/E2/ledger.json`, ledger);
  writeJson(`${OUT}/E2/events.json`, allEvents);
  writeJson(`${OUT}/E2/admin-ai-costs.json`, report);
  writeJson(`${OUT}/E2/metrics-delta.json`, {
    api: Object.fromEntries(['ai_cost_usd_total', 'ai_cost_unknown_total', 'ai_requests_total'].map((n) => [n, delta(apiBefore, apiAfter, n)])),
    curator: Object.fromEntries(['curator_ai_cost_usd_total', 'curator_ai_attempts_total', 'curator_ai_requests_total'].map((n) => [n, delta(curBefore, curAfter, n)])),
  });
  writeJson(`${OUT}/E2/result.json`, result);
  return result;
}

// ── Execucao ─────────────────────────────────────────────────────────────────
seed();
const token = await login(API, TEACHER);
const adminToken = await login(API, ADMIN);
const ip = clientIp(TEACHER);
const courseName = `Sonda C ${randomUUID().slice(0, 8)}`;
const created = await fetch(`${API}/courses`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
  body: JSON.stringify({ name: courseName, acronym: `SC${Date.now() % 10000}`, isIndividual: true, hasClasses: false, hasDisciplines: false, description: 'Curso sintetico da avaliacao integrada de C.' }),
}).then((r) => r.json());
const ctx = { token, ip, courseId: created.courseId, courseName };
if (!ctx.courseId) throw new Error(`curso nao criado: ${JSON.stringify(created)}`);

const results = [];
results.push(await caseE15(ctx));
results.push(await caseE11(ctx));
results.push(await caseE2(ctx, adminToken));
writeJson(`${OUT}/public-summary.json`, results.map(({ id, title, ok, checks }) => ({ id, title, ok, checks })));
for (const r of results) {
  console.log(`${r.ok ? 'PASSA' : 'FALHA'} ${r.id} ${r.title}`);
  for (const c of r.checks) console.log(`   ${c.ok ? 'ok ' : 'XX '} ${c.id}: esperado ${c.esperado} | observado ${c.observado}`);
}
