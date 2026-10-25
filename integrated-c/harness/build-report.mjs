#!/usr/bin/env node
// Gera o quadro de casos (Markdown) a partir das saidas JSON de uma ou mais
// execucoes de run-all.sh e confere determinismo entre execucoes.
//
// Uso: node integrated-C/build-report.mjs <dir-do-pacote>
//   <dir-do-pacote>/run-1, run-2, ... cada um com public/, composition/, mutant/
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const runs = readdirSync(ROOT).filter((d) => /^run-\d+$/.test(d)).sort();
if (!runs.length) throw new Error(`nenhum run-N em ${ROOT}`);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Linhas normalizadas (sem ids, horarios, uuids) para comparar execucoes. */
function collect(dir) {
  const out = [];
  const pub = read(join(dir, 'public', 'public-summary.json'));
  for (const c of pub) {
    for (const ch of c.checks) {
      out.push({ caso: c.id, criterio: ch.id, descricao: ch.descricao, esperado: String(ch.esperado), observado: String(ch.observado), ok: ch.ok });
    }
  }
  const comp = read(join(dir, 'composition', 'composition-summary.json'));
  const jest = read(join(dir, 'composition', 'jest-composition.json'));
  const status = new Map(
    jest.testResults.flatMap((f) => f.assertionResults).map((a) => [a.title.split(':')[0], a.status === 'passed']),
  );
  for (const r of comp) {
    out.push({
      caso: r.id,
      criterio: `${r.id}-identidade`,
      descricao: `sonda de composicao (${r.mode}): ${r.ops.length} operacoes; eventos corretos / sem atribuicao / trocas`,
      esperado: 'trocas = 0',
      observado: `eventos=${r.events} corretos=${r.correct} sem_atribuicao=${r.unattributed} desconhecidos=${r.unknown} trocas=${r.swaps}`,
      ok: status.get(r.id) === true,
    });
  }
  const mutPath = join(dir, 'mutant', 'mutant-control.json');
  if (existsSync(mutPath)) {
    const m = read(mutPath);
    const e = m['E1.2c'];
    out.push({
      caso: 'E1.2c-controle',
      criterio: 'E1.2c-mutante-FIFO',
      descricao: 'controle negativo: com pareamento por posicao, o teste deve acusar trocas',
      esperado: 'trocas > 0',
      observado: `eventos=${e.events} corretos=${e.correct} trocas=${e.swaps}`,
      ok: m.detectado,
    });
  }
  return out;
}

const all = runs.map((r) => ({ run: r, rows: collect(join(ROOT, r)) }));
const base = all[0].rows;
const key = (x) => `${x.criterio}|${x.ok}|${x.observado}`;
const divergent = [];
for (const { run, rows } of all.slice(1)) {
  const a = new Set(base.map(key));
  for (const x of rows) if (!a.has(key(x))) divergent.push({ run, ...x });
  if (rows.length !== base.length) divergent.push({ run, criterio: '(contagem)', observado: `${rows.length} vs ${base.length}` });
}

const esc = (s) => String(s).replace(/\|/g, '\\|');
const lines = [];
lines.push('# Avaliacao integrada de C: quadro de casos');
lines.push('');
lines.push(`Gerado por \`build-report.mjs\` a partir de ${runs.length} execucao(oes): ${runs.join(', ')}.`);
lines.push('Fonte de cada linha: `run-1/public/public-summary.json`, `run-1/composition/composition-summary.json`, `run-1/mutant/mutant-control.json`.');
lines.push('');
const byCase = new Map();
for (const x of base) (byCase.get(x.caso) ?? byCase.set(x.caso, []).get(x.caso)).push(x);
lines.push('## Resumo por caso');
lines.push('');
lines.push('| Caso | Criterios | Atendidos | Resultado |');
lines.push('|---|---:|---:|---|');
for (const [caso, xs] of byCase) {
  const ok = xs.filter((x) => x.ok).length;
  lines.push(`| ${caso} | ${xs.length} | ${ok} | ${ok === xs.length ? 'passa' : 'FALHA'} |`);
}
lines.push('');
lines.push('## Criterios (execucao run-1)');
lines.push('');
lines.push('| Criterio | Descricao | Esperado | Observado | OK |');
lines.push('|---|---|---|---|---|');
for (const x of base) lines.push(`| ${esc(x.criterio)} | ${esc(x.descricao)} | ${esc(x.esperado)} | ${esc(x.observado)} | ${x.ok ? 'sim' : 'NAO'} |`);
lines.push('');
lines.push('## Determinismo entre execucoes');
lines.push('');
if (runs.length < 2) lines.push('Uma execucao so; sem comparacao.');
else if (!divergent.length) lines.push(`Sem divergencia: ${runs.length} execucoes com o mesmo resultado e os mesmos valores observados em todos os ${base.length} criterios.`);
else {
  lines.push('| Execucao | Criterio | Observado | OK |');
  lines.push('|---|---|---|---|');
  for (const d of divergent) lines.push(`| ${d.run} | ${esc(d.criterio)} | ${esc(d.observado)} | ${d.ok} |`);
}
lines.push('');

writeFileSync(join(ROOT, 'QUADRO.md'), lines.join('\n'));
writeFileSync(join(ROOT, 'quadro.json'), JSON.stringify({ runs, rows: base, divergent }, null, 2) + '\n');
const failed = base.filter((x) => !x.ok);
console.log(`criterios: ${base.length}; atendidos: ${base.length - failed.length}; divergencias entre execucoes: ${divergent.length}`);
for (const f of failed) console.log(`  FALHA ${f.criterio}: esperado ${f.esperado} | observado ${f.observado}`);
