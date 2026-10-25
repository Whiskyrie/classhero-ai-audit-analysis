'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./server.js');

let srv;
let base;

before(async () => {
  srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
});
beforeEach(async () => {
  await fetch(`${base}/_reset`, { method: 'POST' });
});

const chat = (mode, headers = {}, body = {}) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(mode ? { 'x-mock-mode': mode } : {}), ...headers },
    body: JSON.stringify({ model: 'anthropic/claude-haiku-5.5', messages: [{ role: 'user', content: 'oi' }], ...body }),
  });

test('ok: custo 0.00065 para 1500 entrada / 1000 saida', async () => {
  const res = await chat('ok');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.model, 'anthropic/claude-haiku-5.5');
  assert.match(j.id, /^gen-\d+$/);
  assert.equal(j.usage.prompt_tokens, 1500);
  assert.equal(j.usage.completion_tokens, 1000);
  assert.equal(j.usage.total_tokens, 2500);
  assert.equal(j.usage.cost, 0.00065);
  assert.equal(j.choices[0].finish_reason, 'stop');
});

test('modo padrao e ok e ids sao unicos', async () => {
  const a = await (await chat(null)).json();
  const b = await (await chat(null)).json();
  assert.equal(a.usage.cost, 0.00065);
  assert.notEqual(a.id, b.id);
});

test('cabecalhos de tokens sobrescrevem a contagem', async () => {
  const j = await (await chat('ok', { 'x-mock-prompt-tokens': '1000000', 'x-mock-completion-tokens': '0' })).json();
  assert.equal(j.usage.cost, 0.1);
});

test('no_usage: resposta sem usage', async () => {
  const j = await (await chat('no_usage')).json();
  assert.equal('usage' in j, false);
  assert.ok(j.choices[0].message.content.length > 0);
});

test('free_cost_zero: usage presente com cost 0', async () => {
  const j = await (await chat('free_cost_zero')).json();
  assert.equal(j.usage.cost, 0);
  assert.equal(j.usage.prompt_tokens, 1500);
});

test('length_with_usage: finish_reason length, conteudo vazio, custo presente', async () => {
  const j = await (await chat('length_with_usage')).json();
  assert.equal(j.choices[0].finish_reason, 'length');
  assert.equal(j.choices[0].message.content, '');
  assert.equal(j.usage.cost, 0.00065);
});

test('rate_limited: 429 com corpo JSON de erro', async () => {
  const res = await chat('rate_limited');
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.ok(j.error && j.error.code === 429);
});

test('/images: custo fixo 0.018 e data URL png', async () => {
  const res = await fetch(`${base}/images`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'bytedance-seed/seedream-5-0-lite', prompt: 'x' }),
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.model, 'bytedance-seed/seedream-5-0-lite');
  assert.equal(j.usage.cost, 0.018);
  assert.equal(j.data[0].b64_json, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  assert.equal(j.data[0].media_type, 'image/png');
  assert.equal('url' in j.data[0], false);
  assert.deepEqual(j.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0.018 });
});

test('chat com modalities image devolve imagem e custo 0.018', async () => {
  const j = await (await chat('ok', {}, { modalities: ['image', 'text'] })).json();
  assert.deepEqual(j.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0.018 });
  assert.match(j.choices[0].message.images[0].image_url.url, /^data:image\/png;base64,/);
});

test('/_stats acumula por modo e /_reset zera', async () => {
  await chat('ok');
  await chat('ok');
  await chat('free_cost_zero');
  await chat('rate_limited');
  const s = await (await fetch(`${base}/_stats`)).json();
  assert.equal(s.calls_total, 4);
  assert.equal(s.by_mode.ok.calls, 2);
  assert.equal(s.by_mode.ok.cost_usd, 0.0013);
  assert.equal(s.by_mode.free_cost_zero.cost_usd, 0);
  assert.equal(s.by_mode.rate_limited.calls, 1);
  assert.equal(s.cost_total_usd, 0.0013);
  await fetch(`${base}/_reset`, { method: 'POST' });
  const z = await (await fetch(`${base}/_stats`)).json();
  assert.deepEqual(z, { calls_total: 0, cost_total_usd: 0, by_mode: {} });
});

test('timeout: nao responde em 300 ms', async () => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 300);
  await assert.rejects(
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'x-mock-mode': 'timeout', 'content-type': 'application/json' },
      body: '{}',
      signal: ac.signal,
    }),
    (e) => e.name === 'AbortError',
  );
  clearTimeout(t);
});

test('body_stall: status 200 chega, corpo trava', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'x-mock-mode': 'body_stall', 'content-type': 'application/json' },
    body: '{}',
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  const t = setTimeout(() => ac.abort(), 300);
  await assert.rejects(res.text(), (e) => e.name === 'AbortError');
  clearTimeout(t);
});

test('modo desconhecido: 400', async () => {
  const res = await chat('banana');
  assert.equal(res.status, 400);
});

// ── Tarefa 9: controle de modo, streaming SSE e deteccao de fluxo ─────────────

const { detectFlow } = require('./server.js');

async function readSse(res) {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));
}

test('POST /_mode arma as proximas N geracoes e depois volta ao padrao', async () => {
  const r = await fetch(`${base}/_mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'rate_limited', count: 2 }),
  });
  assert.equal(r.status, 200);
  assert.equal((await chat(null)).status, 429);
  assert.equal((await chat(null)).status, 429);
  assert.equal((await chat(null)).status, 200);
  const s = await (await fetch(`${base}/_stats`)).json();
  assert.equal(s.by_mode.rate_limited.calls, 2);
  assert.equal(s.by_mode.ok.calls, 1);
});

test('cabecalho x-mock-mode tem precedencia e nao consome a fila', async () => {
  await fetch(`${base}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'rate_limited', count: 1 }) });
  assert.equal((await chat('ok')).status, 200);
  assert.equal((await chat(null)).status, 429);
});

test('POST /_mode rejeita modo desconhecido; /_reset limpa a fila', async () => {
  const bad = await fetch(`${base}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'banana', count: 1 }) });
  assert.equal(bad.status, 400);
  await fetch(`${base}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'rate_limited', count: 5 }) });
  await fetch(`${base}/_reset`, { method: 'POST' });
  assert.equal((await chat(null)).status, 200);
  const m = await (await fetch(`${base}/_mode`)).json();
  assert.equal(m.override, null);
});

test('stream ok: SSE com deltas, usage no ultimo chunk e [DONE]', async () => {
  const res = await chat('ok', {}, { stream: true, max_tokens: 6000, response_format: { type: 'json_object' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const datas = await readSse(res);
  assert.equal(datas.at(-1), '[DONE]');
  const chunks = datas.slice(0, -1).map((d) => JSON.parse(d));
  const content = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
  const parsed = JSON.parse(content);
  assert.ok(parsed.central_concept, 'conteudo do mapa de conhecimento');
  assert.equal(chunks.at(-1).usage.cost, 0.00065);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  const f = await (await fetch(`${base}/_flows`)).json();
  assert.equal(f.by_flow.knowledge_map.calls, 1);
});

test('stream no_usage: nenhum chunk traz usage', async () => {
  const datas = await readSse(await chat('no_usage', {}, { stream: true, max_tokens: 600 }));
  assert.ok(datas.slice(0, -1).every((d) => !('usage' in JSON.parse(d))));
});

test('stream length_with_usage: finish length, sem conteudo, com custo', async () => {
  const datas = await readSse(await chat('length_with_usage', {}, { stream: true, max_tokens: 4000 }));
  const c = JSON.parse(datas[0]);
  assert.equal(c.choices[0].finish_reason, 'length');
  assert.equal(c.usage.cost, 0.00065);
  const s = await (await fetch(`${base}/_stats`)).json();
  assert.equal(s.cost_total_usd, 0.00065);
});

test('stream_abort: usage chega e a conexao cai antes de [DONE]', async () => {
  const res = await chat('stream_abort', {}, { stream: true, max_tokens: 32000 });
  assert.equal(res.status, 200);
  let text = '';
  try {
    text = await res.text();
  } catch {
    // corpo cortado: alguns runtimes rejeitam, outros devolvem o parcial
  }
  assert.ok(!text.includes('[DONE]'));
  const s = await (await fetch(`${base}/_stats`)).json();
  assert.equal(s.by_mode.stream_abort.cost_usd, 0.00065);
});

test('detectFlow: max_tokens por operacao do curador', () => {
  const j = { type: 'json_object' };
  assert.equal(detectFlow({ max_tokens: 32000 }), 'mission_material');
  assert.equal(detectFlow({ max_tokens: 6000, response_format: j }), 'knowledge_map');
  assert.equal(detectFlow({ max_tokens: 12000, response_format: j }), 'story_slides');
  assert.equal(detectFlow({ max_tokens: 10000, response_format: j }), 'mission_proposal');
  assert.equal(detectFlow({ max_tokens: 4000, response_format: j }), 'mission_metadata');
  assert.equal(detectFlow({ max_tokens: 128000, response_format: j }), 'missions');
  assert.equal(
    detectFlow({ max_tokens: 64000, response_format: j, messages: [{ content: 'intencao_pedagogica' }] }),
    'pedagogical',
  );
  assert.equal(detectFlow({ max_tokens: 64000, response_format: j, messages: [] }), 'description');
  assert.equal(
    detectFlow({ max_tokens: 1500, response_format: j, messages: [{ content: 'improved_feedback' }] }),
    'feedback',
  );
  assert.equal(detectFlow({ max_tokens: 600 }), 'short_text');
});

test('chat nao-stream de fluxo JSON devolve o conteudo do fluxo', async () => {
  const j = await (await chat('ok', {}, { max_tokens: 4000, response_format: { type: 'json_object' } })).json();
  assert.ok(JSON.parse(j.choices[0].message.content).rationale);
});

test('/images com prompt de insignia devolve a fixture JPEG real (pipeline de fundo do curador)', async () => {
  const j = await (
    await fetch(`${base}/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bytedance-seed/seedream-5-0-lite', prompt: 'COMMON tier: plain badge' }),
    })
  ).json();
  assert.equal(j.data[0].media_type, 'image/jpeg');
  assert.ok(Buffer.from(j.data[0].b64_json, 'base64').length > 10000);
  assert.equal(j.usage.cost, 0.018);
});

// ── Roteiro por marcador e livro-razao (avaliacao integrada de C) ────────────────
const script = (marker, steps) =>
  fetch(`${base}/_script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ marker, steps }) });
const ledger = async () => (await (await fetch(`${base}/_ledger`)).json()).entries;
const probe = (marker, body = {}) =>
  chat(null, {}, { messages: [{ role: 'user', content: `curso [[probe:${marker}]]` }], ...body });

test('roteiro: custo fixado por marcador e linha no livro-razao', async () => {
  assert.equal((await script('k1', [{ mode: 'ok', cost: 0.9 }])).status, 200);
  const j = await (await probe('k1')).json();
  assert.equal(j.usage.cost, 0.9);
  const [e] = await ledger();
  assert.equal(e.marker, 'k1');
  assert.equal(e.generation_id, j.id);
  assert.equal(e.billed_cost_usd, 0.9);
  assert.equal(e.reported_cost_usd, 0.9);
  assert.equal(e.attempt, 1);
});

test('roteiro: atraso inverte a ordem de termino', async () => {
  await script('lento', [{ cost: 0.1, delay_ms: 900 }]);
  await script('rapido', [{ cost: 0.2, delay_ms: 0 }]);
  await Promise.all([probe('lento'), new Promise((r) => setTimeout(r, 20)).then(() => probe('rapido'))]);
  const l = await ledger();
  const by = Object.fromEntries(l.map((e) => [e.marker, e]));
  assert.ok(by.lento.started_ms < by.rapido.started_ms, 'lento chega primeiro');
  assert.ok(by.rapido.finish_seq < by.lento.finish_seq, 'rapido termina primeiro');
});

test('decode_error_charged: 200, choices invalido, usage cobrado; tentativa seguinte do roteiro', async () => {
  await script('rt', [{ mode: 'decode_error_charged', cost: 0.3 }, { mode: 'ok', cost: 0.5 }]);
  const a = await (await probe('rt')).json();
  assert.equal(typeof a.choices, 'string');
  assert.equal(a.usage.cost, 0.3);
  const b = await (await probe('rt')).json();
  assert.equal(b.usage.cost, 0.5);
  const l = await ledger();
  assert.deepEqual(l.map((e) => [e.attempt, e.mode, e.billed_cost_usd]), [[1, 'decode_error_charged', 0.3], [2, 'ok', 0.5]]);
});

test('no_usage roteirizado: cobrado no oraculo, ausente na resposta', async () => {
  await script('nu', [{ mode: 'no_usage', cost: 0.4 }]);
  const j = await (await probe('nu')).json();
  assert.equal('usage' in j, false);
  const [e] = await ledger();
  assert.equal(e.billed_cost_usd, 0.4);
  assert.equal(e.reported_cost_usd, null);
});

test('stream roteirizado: custo do roteiro no ultimo chunk e livro-razao', async () => {
  await script('st', [{ cost: 0.7 }]);
  const txt = await (await probe('st', { stream: true })).text();
  const usages = txt.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6))).filter((o) => o.usage);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].usage.cost, 0.7);
  const [e] = await ledger();
  assert.equal(e.stream, true);
  assert.equal(e.billed_cost_usd, 0.7);
});

test('requisicao sem marcador nao entra no livro-razao; cabecalho ignora o roteiro', async () => {
  await chat('ok');
  assert.equal((await ledger()).length, 0);
  await script('h', [{ cost: 0.9 }]);
  const j = await (await chat('free_cost_zero', {}, { messages: [{ role: 'user', content: '[[probe:h]]' }] })).json();
  assert.equal(j.usage.cost, 0);
  const l = await ledger();
  assert.equal(l.length, 1);
  assert.equal(l[0].attempt, null); // roteiro nao consumido
  assert.equal(l[0].billed_cost_usd, 0);
  const k = await (await probe('h')).json();
  assert.equal(k.usage.cost, 0.9);
});

test('/_script valida modo e custo; /_reset limpa roteiros e livro-razao', async () => {
  assert.equal((await script('x', [{ mode: 'inexistente' }])).status, 400);
  assert.equal((await script('x', [{ cost: -1 }])).status, 400);
  assert.equal((await script('x y', [{}])).status, 400);
  await script('z', [{ cost: 0.9 }]);
  await probe('z');
  await fetch(`${base}/_reset`, { method: 'POST' });
  assert.equal((await ledger()).length, 0);
  const j = await (await probe('z')).json();
  assert.equal(j.usage.cost, 0.00065);
});
