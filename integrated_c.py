#!/usr/bin/env python3
"""Offline recheck of the integrated evaluation of version C (E1 and E2).

Reads only the released run outputs under ``integrated-c/runs/<package>/`` and
recomputes every verdict from the raw files: the requests sent, the simulator
ledger (the oracle), the exported audit-event rows, the administrative report
responses and the metric deltas. It does not trust ``result.json``,
``QUADRO.md`` or ``quadro.json``; it compares its own verdicts with them.

Standard library only. No network, database, Docker or provider call.

    python3 integrated_c.py                      # all released packages
    python3 integrated_c.py --package 20261025T200826Z
"""
from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / 'integrated-c' / 'runs'
TOL = Decimal('0.000001')  # report and metrics serialise floats; ledger has 5 decimals


def dec(value) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def num(value) -> Decimal:
    """Known amount; raises if unknown (use only where the oracle forbids NULL)."""
    out = dec(value)
    if out is None:
        raise ValueError('unexpected unknown amount')
    return out


def opt0(value) -> Decimal:
    """Unknown counts as 0 in a sum, as in the report. Never used for equality."""
    out = dec(value)
    return Decimal(0) if out is None else out


def same_cost(a, b) -> bool:
    """Equal amounts, or both unknown. Unknown never equals zero."""
    a, b = dec(a), dec(b)
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= TOL


def load(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def final_attempts(ledger: list[dict]) -> dict[str, dict]:
    """Last attempt per marker, i.e. the generation the event must carry."""
    out: dict[str, dict] = {}
    for row in sorted(ledger, key=lambda r: (r['marker'], r['attempt'])):
        out[row['marker']] = row
    return out


def classify(rows: list[tuple[str, str | None, object]], ledger: list[dict]) -> dict:
    """rows: (expected marker, generation_id on the event, cost_usd on the event).

    correct: the generation belongs to the expected marker and the cost equals
    the cost the simulator reported for it. swap: anything else with a
    generation. unattributed: no generation on the event.
    """
    by_gen = {r['generation_id']: r for r in ledger}
    res = {'events': len(rows), 'correct': 0, 'swaps': 0, 'unattributed': 0, 'unknown': 0}
    for marker, gen, cost in rows:
        if cost is None:
            res['unknown'] += 1
        if gen is None:
            res['unattributed'] += 1
            continue
        oracle = by_gen.get(gen)
        if oracle and oracle['marker'] == marker and same_cost(cost, oracle['reported_cost_usd']):
            res['correct'] += 1
        else:
            res['swaps'] += 1
    return res


def check(results: list, cid: str, ok: bool, observed) -> None:
    results.append({'id': cid, 'ok': bool(ok), 'observed': observed})


def public_identity(case_dir: Path, results: list, prefix: str, inverted: bool) -> None:
    sent = load(case_dir / 'sent.json')
    ledger = load(case_dir / 'ledger.json')
    events = load(case_dir / 'events.json')
    marker_of = {s['requestId']: s['marker'] for s in sent}
    per_request = {s['requestId']: 0 for s in sent}
    rows = []
    for e in events:
        if e['request_id'] in per_request:
            per_request[e['request_id']] += 1
        rows.append((marker_of.get(e['request_id']), e['generation_id'], e['cost_usd']))
    check(results, f'{prefix}-http', all(200 <= s['status'] < 300 and s.get('echoed') == s['requestId'] for s in sent),
          [s['status'] for s in sent])
    cls = classify(rows, ledger)
    one_each = all(n == 1 for n in per_request.values()) and len(events) == len(sent)
    check(results, f'{prefix}-ident', one_each and cls['swaps'] == 0 and cls['correct'] == len(sent), cls)
    if inverted:
        finish = [r['marker'] for r in sorted(ledger, key=lambda r: r['finish_seq'])]
        start = [s['marker'] for s in sent]
        check(results, f'{prefix}-ordem', finish == list(reversed(start)), finish)


def effective(e: dict) -> Decimal:
    base = dec(e['cost_usd'])
    if base is None:
        base = opt0(e.get('estimated_cost_usd'))
    return base + opt0(e['failed_attempts_cost_usd'])


def known(e: dict) -> bool:
    return e['cost_usd'] is not None or e.get('estimated_cost_usd') is not None


def e2(case_dir: Path, results: list) -> None:
    sent = load(case_dir / 'sent.json')
    ledger = load(case_dir / 'ledger.json')
    events = load(case_dir / 'events.json')
    report = load(case_dir / 'admin-ai-costs.json')
    only_unknown = load(case_dir / 'admin-ai-costs-only-unknown.json')
    metrics = load(case_dir / 'metrics-delta.json')
    final = final_attempts(ledger)
    by_req = {e['request_id']: e for e in events}

    check(results, 'E2-http', all(200 <= s['status'] < 300 for s in sent), [s['status'] for s in sent])
    per_event_ok = True
    for s in sent:
        e, f = by_req.get(s['requestId']), final[s['marker']]
        earlier = [r for r in ledger if r['marker'] == s['marker'] and r['attempt'] < f['attempt']]
        earlier_cost = sum((opt0(r['reported_cost_usd']) for r in earlier), Decimal(0))
        ok = (e is not None and e['generation_id'] == f['generation_id']
              and same_cost(e['cost_usd'], f['reported_cost_usd'])
              and same_cost(e['failed_attempts_cost_usd'], earlier_cost if earlier else None)
              and (e['attempt_count'] or 1) == f['attempt'])
        per_event_ok &= ok
        check(results, f"{s['sub']}-evento", ok, None if e is None else {
            'cost_usd': e['cost_usd'], 'failed_attempts_cost_usd': e['failed_attempts_cost_usd'],
            'attempt_count': e['attempt_count']})
    check(results, 'E2-eventos', len(events) == len(sent), len(events))

    reported = sum((opt0(r['reported_cost_usd']) for r in ledger), Decimal(0))
    billed = sum((opt0(r['billed_cost_usd']) for r in ledger), Decimal(0))
    from_events = sum((effective(e) for e in events), Decimal(0))
    unknown_ops = sum(1 for f in final.values() if f['reported_cost_usd'] is None)
    free_ops = sum(1 for f in final.values() if f['reported_cost_usd'] is not None
                   and all(dec(r['reported_cost_usd']) == Decimal(0) for r in ledger if r['marker'] == f['marker']))
    summ = report['summary']
    total = num(summ['totalCostInUsd'])
    check(results, 'E2-rel-total', abs(total - reported) <= TOL and abs(from_events - reported) <= TOL,
          {'report': str(total), 'events': str(from_events), 'oracle': str(reported)})
    check(results, 'E2-rel-desconhecido', summ['unknownCostRequests'] == unknown_ops, summ['unknownCostRequests'])
    check(results, 'E2-rel-gratis', summ['freeRequests'] == free_ops, summ['freeRequests'])
    check(results, 'E2-rel-completo', summ['unknownCostRequests'] > 0 and total < billed,
          {'unknown': summ['unknownCostRequests'], 'total': str(total), 'billed': str(billed)})

    def sums_to_total(items, key):
        return abs(sum((num(x[key]) for x in items), Decimal(0)) - total) <= TOL

    daily = [m for d in report['dailyUsage'] for m in d['byModel']]
    check(results, 'E2-rel-modelo', sums_to_total(report['breakdownByModel'], 'costInUsd'),
          [m['costInUsd'] for m in report['breakdownByModel']])
    # Recomputed only here (the original harness checks the model breakdown):
    check(results, 'E2-rel-dia-endpoint-usuario',
          sums_to_total(daily, 'cost') and sums_to_total(report['breakdownByEndpoint'], 'costInUsd')
          and sums_to_total(report['breakdownByUser'], 'costInUsd'),
          {'daily': [m['cost'] for m in daily],
           'endpoint': [x['costInUsd'] for x in report['breakdownByEndpoint']],
           'user': [x['costInUsd'] for x in report['breakdownByUser']]})
    free_models = {}
    for e in events:
        free_models.setdefault(e['model_name'], []).append(known(e) and effective(e) == 0)
    expect_free = {k: all(v) for k, v in free_models.items()}
    check(results, 'E2-rel-isFree', all(m['isFree'] == expect_free.get(m['modelName']) for m in report['breakdownByModel']),
          {m['modelName']: m['isFree'] for m in report['breakdownByModel']})

    api, cur = metrics['api'], metrics['curator']
    check(results, 'E2-met-api-custo', abs(num(api['ai_cost_usd_total']) - reported) <= TOL, api['ai_cost_usd_total'])
    check(results, 'E2-met-api-desconhecido', api['ai_cost_unknown_total'] == unknown_ops, api['ai_cost_unknown_total'])
    check(results, 'E2-met-curador', abs(num(cur['curator_ai_cost_usd_total']) - reported) <= TOL,
          cur['curator_ai_cost_usd_total'])

    u = only_unknown['summary']
    check(results, 'E2.f-rel-gratis', u['freeRequests'] == 0 and u['unknownCostRequests'] == 1,
          {'free': u['freeRequests'], 'unknown': u['unknownCostRequests']})
    check(results, 'E2.f-rel-modelo-gratis', all(m['isFree'] is False for m in only_unknown['breakdownByModel']),
          [m['isFree'] for m in only_unknown['breakdownByModel']])


def composition(path: Path, results: list) -> None:
    for case in load(path):
        rows = [(r['marker'], r['generation_id'], r['cost_usd']) for r in case['event_rows']]
        cls = classify(rows, case['ledger'])
        markers = {op.split(':')[0] for op in case['ops']}
        covered = {r['marker'] for r in case['event_rows']} == markers and len(rows) == len(markers)
        if case['id'] == 'E1.2c':
            # No key and several pending traces: no guess. Every event is unpaired and marked.
            ok = covered and cls['swaps'] == 0 and cls['unattributed'] == len(rows) and all(
                r['identity'] == 'ambiguous_unpaired' and r['cost_usd'] is None for r in case['event_rows'])
        else:
            ok = covered and cls['swaps'] == 0 and cls['correct'] == len(rows)
        same_as_harness = all(cls[k] == case[k] for k in ('events', 'correct', 'swaps', 'unattributed', 'unknown'))
        check(results, f"{case['id']}-identidade", ok and same_as_harness, cls)


def mutant(path: Path, results: list) -> None:
    rows = load(path)
    case = next(c for c in rows if c['id'] == 'E1.2c')
    cls = classify([(r['marker'], r['generation_id'], r['cost_usd']) for r in case['event_rows']], case['ledger'])
    check(results, 'E1.2c-mutante-FIFO', cls['swaps'] > 0, cls)


def verify_run(run: Path) -> list[dict]:
    results: list[dict] = []
    public_identity(run / 'public' / 'E1.5', results, 'E1.5', inverted=False)
    public_identity(run / 'public' / 'E1.1', results, 'E1.1', inverted=True)
    e2(run / 'public' / 'E2', results)
    composition(run / 'composition' / 'composition-summary.json', results)
    mutant(run / 'mutant' / 'composition-summary.json', results)
    return results


def verify_package(pkg: Path) -> dict:
    runs = sorted(p for p in pkg.iterdir() if p.is_dir() and p.name.startswith('run-'))
    per_run = {r.name: verify_run(r) for r in runs}
    failed = {name: [c['id'] for c in res if not c['ok']] for name, res in per_run.items()}
    first = per_run[runs[0].name]

    # Determinism: same verdict and same observed values in every run. The
    # observed values carry no generated ids, which differ between runs by design.
    def key(res):
        return {c['id']: (c['ok'], json.dumps(c['observed'], sort_keys=True)) for c in res}
    base = key(first)
    divergent = sorted({cid for res in per_run.values() for cid, v in key(res).items() if base.get(cid) != v})

    # Agreement with the harness table, on the criteria both define.
    harness = {r['criterio']: r['ok'] for r in load(pkg / 'quadro.json')['rows']}
    mine = {c['id']: c['ok'] for c in first}
    shared = sorted(set(harness) & set(mine))
    return {
        'package': pkg.name,
        'runs': [r.name for r in runs],
        'checks_per_run': len(first),
        'failed': failed,
        'divergent_between_runs': divergent,
        'harness_criteria_shared': len(shared),
        'harness_disagreements': [c for c in shared if harness[c] != mine[c]],
        'only_in_recheck': sorted(set(mine) - set(harness)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Offline recheck of the integrated evaluation of C.')
    parser.add_argument('--package', help='package directory name under integrated-c/runs')
    args = parser.parse_args()
    pkgs = [RUNS / args.package] if args.package else sorted(p for p in RUNS.iterdir() if p.is_dir())
    summaries = [verify_package(p) for p in pkgs]
    print(json.dumps(summaries, indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
