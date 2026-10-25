'use strict';
// Provedor OpenRouter simulado: permite rodar o curador e os testes a custo zero.
// Modo por requisicao, em ordem de precedencia:
//   1. cabecalho `x-mock-mode`;
//   2. fila de controle armada por `POST /_mode {mode, count}` (as proximas `count`
//      geracoes sem cabecalho usam `mode`; e assim que a carga provoca falhas ponta a
//      ponta, ja que a API nao repassa cabecalhos arbitrarios ao curador);
//   3. MOCK_DEFAULT_MODE ou `ok`.
// Roteiro por marcador (avaliacao integrada de C): um teste injeta `[[probe:<id>]]` num
// campo de entrada que chega ao prompt; `POST /_script {marker, steps}` define, por
// tentativa, modo, custo, tokens e atraso (`delay_ms`, aplicado antes do termino). O
// roteiro vale para requisicoes sem `x-mock-mode` e tem precedencia sobre a fila `/_mode`.
// `GET /_ledger` devolve uma linha por geracao (marcador, id, custo cobrado, custo
// informado, ordem de termino): e o oraculo independente, fixado aqui e nao pela API.
// Com `stream: true` no corpo, `/chat/completions` responde em SSE (formato do OpenRouter),
// com o conteudo escolhido pelo fluxo detectado (ver detectFlow) para que os parsers do
// curador aceitem a resposta.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const MODES = [
  'ok',
  'no_usage',
  'free_cost_zero',
  'length_with_usage',
  'rate_limited',
  'timeout',
  'body_stall',
  'stream_abort',
  // 200 com JSON valido e `usage` cobrado, mas `choices` fora do formato: o curador nao
  // decodifica, registra o custo da tentativa e tenta de novo (retry cobrado).
  'decode_error_charged',
];
const MARKER_RE = /\[\[probe:([A-Za-z0-9_-]{1,40})\]\]/;
const findMarker = (body) => {
  const m = MARKER_RE.exec(JSON.stringify((body && (body.messages || body.prompt)) || ''));
  return m ? m[1] : null;
};
const PRICE_IN_PER_M = 0.1;
const PRICE_OUT_PER_M = 0.5;
const IMAGE_COST = 0.018;
const DEFAULT_PROMPT_TOKENS = 1500;
const DEFAULT_COMPLETION_TOKENS = 1000;
const STREAM_PIECES = 40;
// PNG 1x1 valido
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${TINY_PNG_B64}`;
// Insignia real (fixture v3 do curador, tests/fixtures/badges/git__common__v3.jpg): o
// pipeline de insignia remove o fundo e rejeita um PNG 1x1 (BADGE_BACKGROUND_NOT_REMOVABLE).
const BADGE_JPG_B64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'badge.jpg')).toString('base64');
const isBadgePrompt = (body) => /badge/i.test(JSON.stringify(body.prompt || body.messages || ''));

const FLOW_CONTENT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'flows.json'), 'utf8'));
FLOW_CONTENT.material_metadata = JSON.stringify({
  title: 'Guia de branches',
  description: 'Material de apoio sobre branches e merge.',
});

const round8 = (n) => Math.round(n * 1e8) / 1e8;
const textCost = (p, c) => round8((p * PRICE_IN_PER_M + c * PRICE_OUT_PER_M) / 1e6);

/**
 * Identifica o fluxo do curador pela forma da requisicao. `max_tokens` e fixo por
 * operacao em `ChatOptions::for_operation` (RS/services/ai/openrouter/types.rs) e igual
 * em A e B; os dois casos ambiguos (64000 e 1500) sao separados por uma chave do prompt.
 */
function detectFlow(body) {
  const mt = body && body.max_tokens;
  const json = Boolean(body && body.response_format && body.response_format.type === 'json_object');
  const prompt = JSON.stringify((body && body.messages) || []);
  if (mt === 32000 && !json) return 'mission_material';
  if (mt === 6000) return 'knowledge_map';
  if (mt === 12000) return 'story_slides';
  if (mt === 10000) return 'mission_proposal';
  if (mt === 4000) return 'mission_metadata';
  if (mt === 128000) return 'missions';
  if (mt === 64000) return prompt.includes('intencao_pedagogica') ? 'pedagogical' : 'description';
  if (mt === 1500 && json) return prompt.includes('improved_feedback') ? 'feedback' : 'material_metadata';
  return 'short_text';
}

function splitPieces(text, n = STREAM_PIECES) {
  const chars = Array.from(text);
  const size = Math.max(1, Math.ceil(chars.length / n));
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function createServer({ defaultMode = process.env.MOCK_DEFAULT_MODE || 'ok' } = {}) {
  let counter = 0;
  let stats;
  let flows;
  let override = null; // { mode, remaining }
  let scripts; // marker -> { steps, used }
  let ledger;
  let finishSeq;
  const t0 = process.hrtime.bigint();
  const nowMs = () => Number(process.hrtime.bigint() - t0) / 1e6;
  const resetStats = () => {
    stats = { calls_total: 0, cost_total_usd: 0, by_mode: {} };
    flows = {};
    scripts = new Map();
    ledger = [];
    finishSeq = 0;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextStep = (marker) => {
    const s = marker && scripts.get(marker);
    if (!s) return null;
    const attempt = s.used + 1;
    const step = s.steps[Math.min(s.used, s.steps.length - 1)];
    s.used += 1;
    return { ...step, attempt };
  };
  // billed: o que o provedor cobraria; reported: o que a resposta informa (null = ausente).
  const addLedger = (entry) => {
    ledger.push({ ...entry, finished_ms: Math.round(nowMs() * 1000) / 1000, finish_seq: ++finishSeq });
  };
  resetStats();

  const record = (mode, cost, flow) => {
    const m = (stats.by_mode[mode] ||= { calls: 0, cost_usd: 0 });
    m.calls += 1;
    m.cost_usd = round8(m.cost_usd + cost);
    stats.calls_total += 1;
    stats.cost_total_usd = round8(stats.cost_total_usd + cost);
    const f = (flows[flow] ||= { calls: 0, cost_usd: 0, by_mode: {} });
    f.calls += 1;
    f.cost_usd = round8(f.cost_usd + cost);
    f.by_mode[mode] = (f.by_mode[mode] || 0) + 1;
  };

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const intHeader = (req, name, dflt) => {
    const v = Number.parseInt(req.headers[name], 10);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };

  const resolveMode = (req) => {
    if (req.headers['x-mock-mode']) return String(req.headers['x-mock-mode']);
    if (override && override.remaining > 0) {
      override.remaining -= 1;
      const { mode } = override;
      if (override.remaining === 0) override = null;
      return mode;
    }
    return defaultMode;
  };

  async function handleStream(req, res, { id, model, mode, flow, prompt, completion, step, base }) {
    const content = FLOW_CONTENT[flow] || FLOW_CONTENT.short_text;
    let cost = step && typeof step.cost === 'number' ? step.cost : textCost(prompt, completion);
    if (mode === 'free_cost_zero') cost = 0;
    const delay = (step && step.delay_ms) || 0;
    const led = (billed, reported) => base && addLedger({ ...base, mode, billed_cost_usd: billed, reported_cost_usd: reported, prompt_tokens: prompt, completion_tokens: completion });
    const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost };
    const chunk = (obj) => res.write(`data: ${JSON.stringify({ id, model, ...obj })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    if (mode === 'decode_error_charged') {
      // Sem retry no caminho de stream do curador: modo so faz sentido fora de stream.
      record(mode, 0, flow);
      led(0, null);
      res.end(`data: ${JSON.stringify({ error: { code: 400, message: 'decode_error_charged nao suportado em stream' } })}\n\n`);
      return;
    }
    if (mode === 'body_stall') {
      record(mode, 0, flow);
      led(0, null);
      chunk({ choices: [{ index: 0, delta: { content: splitPieces(content)[0] }, finish_reason: null }] });
      return; // trava depois do primeiro delta
    }
    if (mode === 'length_with_usage') {
      if (delay) await sleep(delay);
      record(mode, cost, flow);
      led(cost, cost);
      chunk({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'length' }], usage });
      res.end('data: [DONE]\n\n');
      return;
    }
    const pieces = splitPieces(content);
    if (mode === 'stream_abort') {
      // Parte do conteudo e o usage chegam; depois a conexao cai (Review Focus 3).
      for (const p of pieces.slice(0, Math.ceil(pieces.length / 2))) {
        chunk({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
      }
      if (delay) await sleep(delay);
      record(mode, cost, flow);
      led(cost, cost);
      chunk({ choices: [], usage });
      setTimeout(() => res.socket && res.socket.destroy(), 20);
      return;
    }
    for (const p of pieces) chunk({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
    if (delay) await sleep(delay);
    const last = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    if (mode !== 'no_usage') last.usage = usage;
    chunk(last);
    record(mode, mode === 'no_usage' ? 0 : cost, flow);
    // no_usage: o provedor cobraria, mas nao informa; o oraculo guarda as duas coisas.
    led(cost, mode === 'no_usage' ? null : cost);
    res.end('data: [DONE]\n\n');
  }

  async function handleGeneration(req, res, kind) {
    const body = await readBody(req);
    const marker = findMarker(body);
    const step = req.headers['x-mock-mode'] ? null : nextStep(marker);
    const mode = step && step.mode ? step.mode : resolveMode(req);
    if (!MODES.includes(mode)) {
      return send(res, 400, { error: { code: 400, message: `x-mock-mode desconhecido: ${mode}` } });
    }
    const id = `gen-${++counter}`;
    const startedMs = Math.round(nowMs() * 1000) / 1000;
    const model = body.model || (kind === 'images' ? 'bytedance-seed/seedream-5-0-lite' : 'anthropic/claude-haiku-5.5');
    const wantsImage =
      kind === 'images' || (Array.isArray(body.modalities) && body.modalities.includes('image'));
    const flow = wantsImage ? (isBadgePrompt(body) ? 'image_badge' : 'image') : detectFlow(body);
    const stream = body.stream === true && !wantsImage;
    const base = marker
      ? { marker, attempt: step ? step.attempt : null, generation_id: id, flow, stream, started_ms: startedMs }
      : null;
    const delay = (step && step.delay_ms) || 0;

    if (mode === 'rate_limited') {
      if (delay) await sleep(delay);
      record(mode, 0, flow);
      if (base) addLedger({ ...base, mode, billed_cost_usd: 0, reported_cost_usd: null });
      return send(res, 429, { error: { code: 429, message: 'Rate limit exceeded (simulado)' } });
    }
    if (mode === 'timeout') {
      record(mode, 0, flow);
      if (base) addLedger({ ...base, mode, billed_cost_usd: 0, reported_cost_usd: null });
      return; // nunca responde; o cliente encerra a conexao
    }

    const prompt = step && Number.isInteger(step.prompt_tokens) ? step.prompt_tokens : intHeader(req, 'x-mock-prompt-tokens', DEFAULT_PROMPT_TOKENS);
    const completion = step && Number.isInteger(step.completion_tokens) ? step.completion_tokens : intHeader(req, 'x-mock-completion-tokens', DEFAULT_COMPLETION_TOKENS);

    if (stream) {
      return void handleStream(req, res, { id, model, mode, flow, prompt, completion, step, base });
    }

    if (mode === 'body_stall' || mode === 'stream_abort') {
      record(mode, 0, flow);
      if (base) addLedger({ ...base, mode, billed_cost_usd: 0, reported_cost_usd: null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":"' + id + '","choices":[');
      if (mode === 'stream_abort') setTimeout(() => res.socket && res.socket.destroy(), 20);
      return; // corpo parcial, depois trava (ou cai)
    }

    let cost = step && typeof step.cost === 'number' ? step.cost : wantsImage ? IMAGE_COST : textCost(prompt, completion);
    if (mode === 'free_cost_zero') cost = 0;
    if (delay) await sleep(delay);

    const usage = wantsImage
      ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost }
      : { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost };

    const out = { id, model };
    const badge = wantsImage && isBadgePrompt(body);
    if (mode === 'decode_error_charged') {
      out.choices = 'formato-invalido';
      out.usage = usage;
      record(mode, cost, flow);
      if (base) addLedger({ ...base, mode, billed_cost_usd: cost, reported_cost_usd: cost, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens });
      return send(res, 200, out);
    }
    if (kind === 'images') {
      out.data = [badge ? { b64_json: BADGE_JPG_B64, media_type: 'image/jpeg' } : { b64_json: TINY_PNG_B64, media_type: 'image/png' }];
    } else if (wantsImage) {
      const url = badge ? `data:image/jpeg;base64,${BADGE_JPG_B64}` : PNG_URL;
      out.choices = [
        {
          message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url } }] },
          finish_reason: 'stop',
        },
      ];
    } else if (mode === 'length_with_usage') {
      out.choices = [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }];
    } else {
      const content = flow === 'short_text' ? 'Resposta simulada.' : FLOW_CONTENT[flow];
      out.choices = [{ message: { role: 'assistant', content }, finish_reason: 'stop' }];
    }
    if (mode !== 'no_usage') out.usage = usage;

    // Em no_usage o provedor nao informa custo: contabiliza o que seria servido como 0
    record(mode, mode === 'no_usage' ? 0 : cost, flow);
    if (base) {
      addLedger({ ...base, mode, billed_cost_usd: cost, reported_cost_usd: mode === 'no_usage' ? null : cost, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens });
    }
    send(res, 200, out);
  }

  async function handleScript(req, res) {
    const body = await readBody(req);
    const marker = String(body.marker || '');
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(marker) || steps.length === 0) {
      return send(res, 400, { error: { code: 400, message: 'marker invalido ou steps vazio' } });
    }
    for (const s of steps) {
      if (s.mode !== undefined && !MODES.includes(s.mode)) {
        return send(res, 400, { error: { code: 400, message: `modo invalido no roteiro: ${s.mode}` } });
      }
      if (s.cost !== undefined && !(typeof s.cost === 'number' && s.cost >= 0)) {
        return send(res, 400, { error: { code: 400, message: 'cost deve ser numero >= 0' } });
      }
    }
    scripts.set(marker, { steps, used: 0 });
    send(res, 200, { ok: true, marker, steps: steps.length });
  }

  async function handleModeControl(req, res) {
    const body = await readBody(req);
    const mode = String(body.mode || '');
    const count = Number.isInteger(body.count) ? body.count : 1;
    if (!MODES.includes(mode) || count < 0) {
      return send(res, 400, { error: { code: 400, message: 'mode invalido ou count < 0' } });
    }
    override = count > 0 ? { mode, remaining: count } : null;
    send(res, 200, { ok: true, override });
  }

  const server = http.createServer((req, res) => {
    const p = (req.url || '').split('?')[0];
    if (req.method === 'POST' && p === '/chat/completions') return void handleGeneration(req, res, 'chat');
    if (req.method === 'POST' && p === '/images') return void handleGeneration(req, res, 'images');
    if (req.method === 'GET' && p === '/_stats') return send(res, 200, stats);
    if (req.method === 'GET' && p === '/_flows') return send(res, 200, { by_flow: flows, override });
    if (req.method === 'POST' && p === '/_mode') return void handleModeControl(req, res);
    if (req.method === 'POST' && p === '/_script') return void handleScript(req, res);
    if (req.method === 'GET' && p === '/_ledger') return send(res, 200, { entries: ledger });
    if (req.method === 'GET' && p === '/_mode') return send(res, 200, { override });
    if (req.method === 'POST' && p === '/_reset') {
      resetStats();
      override = null;
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: { code: 404, message: 'not found' } });
  });
  return server;
}

module.exports = { createServer, MODES, detectFlow, splitPieces };

if (require.main === module) {
  const port = Number(process.env.PORT || 4010);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`mock-openrouter ouvindo em ${host}:${port}`));
}
