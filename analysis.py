#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Offline reanalysis of the released, pseudonymized ClassHero observations."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
from collections import Counter
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVENT_COLUMNS = (
    'round occurred_at_utc user_pseudo user_role domain feature action route_template '
    'model_provider model_name prompt_tokens completion_tokens total_tokens cost_usd '
    'estimated_cost_usd latency_ms success error_code request_id generation_id '
    'usage_reported attempt_count failed_attempts_cost_usd'
).split()
CALL_COLUMNS = (
    'round seq ts_start_utc ts_end_utc flow action user_pseudo planned_kind '
    'failure_mode failure_attempts_armed http_status outcome error_code latency_ms '
    'request_id reconstructed'
).split()
IMAGE_ACTIONS = {'hero_avatar_generate', 'cover_generate', 'badge_image_generate'}
CALL_ROUNDS = {'A', 'B', 'B-mock', 'B-audit-off', 'B-db-fail'}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def decimal(value: str | int | None) -> Decimal:
    return Decimal(str(value)) if value not in ('', None) else Decimal(0)


def money(value: Decimal) -> str:
    return format(value, '.8f')


def percentile(values: list[int], p: int) -> int | None:
    if not 0 < p <= 100:
        raise ValueError('Percentile must be in (0, 100].')
    return sorted(values)[math.ceil(len(values) * p / 100) - 1] if values else None


def read_csv(path: Path, columns: list[str]) -> list[dict[str, str]]:
    with path.open(encoding='utf-8', newline='') as handle:
        reader = csv.DictReader(handle)
        require(reader.fieldnames == columns, f'Unexpected schema: {path.name}')
        rows = list(reader)
    for row in rows:
        require(None not in row and all(v is not None for v in row.values()),
                f'Malformed CSV row: {path.name}')
        require(bool(re.fullmatch(r'user-(?:00[1-9]|01[0-9]|02[0-5])', row['user_pseudo'])),
                f'Unexpected pseudonym: {path.name}')
    return rows


def verify_manifest(root: Path) -> int:
    manifest = json.loads((root / 'MANIFEST.json').read_text(encoding='utf-8'))
    for relative, expected in manifest['sha256'].items():
        path = root / relative
        require(path.resolve().is_relative_to(root.resolve()), 'Unsafe manifest path')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected,
                f'SHA-256 mismatch: {relative}')
    require(hashlib.sha256((root / 'data/workload.json').read_bytes()).hexdigest()
            == 'e5a2209f07553cead9765bd068a678d2fbfbb7c4b2bf0194027864738f15174d',
            'Published workload bytes do not match the historical file hash')
    return len(manifest['sha256'])


def is_image(event: dict[str, str]) -> bool:
    return event['action'] in IMAGE_ACTIONS or 'seedream' in event['model_name'].lower()


def event_cost(event: dict[str, str]) -> Decimal:
    return decimal(event['cost_usd'] or event['estimated_cost_usd']) + decimal(event['failed_attempts_cost_usd'])


def has_cost(event: dict[str, str]) -> bool:
    value = event['cost_usd'] or event['estimated_cost_usd']
    return value != '' and not (decimal(value) == 0 and event['usage_reported'] != 'True')


def has_tokens(event: dict[str, str]) -> bool:
    if not event['prompt_tokens'] or not event['completion_tokens']:
        return False
    ambiguous = all(decimal(event[k]) == 0 for k in ('prompt_tokens', 'completion_tokens', 'total_tokens'))
    return not (ambiguous and event['usage_reported'] != 'True')


def percent(numerator: int, denominator: int) -> float | None:
    return numerator * 100 / denominator if denominator else None


def analyse(root: Path = ROOT) -> dict:
    events = read_csv(root / 'data/ai_usage_events_A_B.csv', EVENT_COLUMNS)
    calls = read_csv(root / 'data/calls_all_rounds.csv', CALL_COLUMNS)
    require(len(events) == 1280 and len(calls) == 3200, 'Unexpected dataset sizes')
    require({r['round'] for r in events} == {'A', 'B'}, 'Unexpected event rounds')
    require({r['round'] for r in calls} == CALL_ROUNDS, 'Unexpected call rounds')
    reference = json.loads((root / 'evidence/provider_reference.json').read_text(encoding='utf-8'))
    recorded = json.loads((root / 'evidence/simulated_audit_counts.json').read_text(encoding='utf-8'))
    result = {'method': 'Offline reanalysis; no application, database or provider calls',
              'cost_unit': 'USD; Decimal arithmetic; eight decimal places',
              'percentile_method': 'nearest-rank; calls with a measured latency only',
              'real_rounds': {}, 'call_rounds': {}}
    for label in sorted(CALL_ROUNDS):
        rows = [r for r in calls if r['round'] == label]
        require(len(rows) == 640, f'Unexpected call count in {label}')
        require({int(r['seq']) for r in rows} == set(range(1, 641)), f'Missing/duplicate sequence in {label}')
        latencies = [int(r['latency_ms']) for r in rows if r['latency_ms'] != '']
        planned = [r for r in rows if r['planned_kind'] == 'ok']
        result['call_rounds'][label] = {
            'calls': len(rows), 'outcomes': dict(sorted(Counter(r['outcome'] for r in rows).items())),
            'measured_latencies': len(latencies), 'p50_ms': percentile(latencies, 50),
            'p95_ms': percentile(latencies, 95),
            'reconstructed_rows': sum(r['reconstructed'] == 'True' for r in rows),
            'planned_ok_calls': len(planned),
            'planned_ok_completed': sum(r['outcome'] == 'done' for r in planned),
        }
    for label in ('A', 'B'):
        rows = [r for r in events if r['round'] == label]
        require(len(rows) == 640, f'Unexpected event count in {label}')
        texts = [r for r in rows if not is_image(r)]
        images = [r for r in rows if is_image(r)]
        ref = reference['rounds'][label]
        provider = decimal(ref['key_usage_after_usd']) - decimal(ref['key_usage_before_usd'])
        require(provider == decimal(ref['recorded_round_total_provider_usd']), 'Inconsistent provider reference')
        audited = sum((event_cost(r) for r in rows), Decimal(0))
        result['real_rounds'][label] = {
            'audit_events': len(rows), 'text_events': len(texts), 'image_events': len(images),
            'audited_usd': money(audited), 'provider_usd': money(provider),
            'divergence_usd': money(audited - provider),
            'complete_text_tokens': sum(has_tokens(r) for r in texts),
            'complete_text_tokens_pct': percent(sum(has_tokens(r) for r in texts), len(texts)),
            'complete_cost_events': sum(has_cost(r) for r in rows),
            'complete_cost_pct': percent(sum(has_cost(r) for r in rows), len(rows)),
            'complete_events': sum(has_cost(r) and (is_image(r) or has_tokens(r)) for r in rows),
            'events_with_request_id': sum(bool(r['request_id']) for r in rows),
            'failed_call_events': sum(r['success'] == 'False' for r in rows),
            'audited_failed_calls_usd': money(sum((event_cost(r) for r in rows if r['success'] == 'False'), Decimal(0))),
        }
    b = [r for r in events if r['round'] == 'B' and not is_image(r)]
    generations = reference['rounds']['B']['text_generations']
    by_id = {r['generation_id']: r for r in generations}
    require(len(by_id) == len(generations) == len(b) == 600, 'Nonunique/missing generation reference')
    require({r['generation_id'] for r in b} == set(by_id), 'Unmatched generation identifiers')
    cost_matches = sum(decimal(e['cost_usd'] or e['estimated_cost_usd']) == decimal(by_id[e['generation_id']]['provider_cost_usd']) for e in b)
    token_matches = sum(
        decimal(e['prompt_tokens']) == decimal(by_id[e['generation_id']]['provider_native_prompt'])
        and decimal(e['completion_tokens']) == decimal(by_id[e['generation_id']]['provider_native_completion']) for e in b)
    provider_text = sum((decimal(g['provider_cost_usd']) for g in generations), Decimal(0))
    result['b_recorded_provider_comparison'] = {
        'text_generations': len(generations), 'exact_cost_matches': cost_matches,
        'exact_token_matches': token_matches, 'provider_text_usd': money(provider_text),
        'image_usd_derived_from_round_minus_text': money(decimal(result['real_rounds']['B']['provider_usd']) - provider_text),
        'provenance': 'Whitelisted fields from recorded provider-truth.json; not new provider queries',
    }
    mock = {int(r['seq']): r for r in calls if r['round'] == 'B-mock'}
    failing = {int(r['seq']): r for r in calls if r['round'] == 'B-db-fail'}
    same = sum(all(mock[i][k] == failing[i][k] for k in ('outcome', 'http_status', 'error_code')) for i in mock)
    require(same == 640, 'Simulated outcomes no longer match')
    persisted = recorded['rounds']['B-db-fail']['events_in_db']
    missing = len(failing) - persisted
    require(missing == recorded['rounds']['B-db-fail']['ai_audit_write_failures_total'], 'Inconsistent recorded failure counter')
    result['simulated_insert_failure'] = {
        'identical_call_outcomes': same, 'recorded_persisted_audit_events': persisted,
        'missing_audit_events': missing,
        'planned_ok_completed': result['call_rounds']['B-db-fail']['planned_ok_completed'],
        'provenance': 'Call outcomes recomputed from released CSV; persisted count and failure counter from recorded summary, not raw database reanalysis',
        'interpretation': 'Injected audit INSERT failures; not 318 provider-call failures',
    }
    return result


def render_report(result: dict) -> str:
    lines = ['# ClassHero AI audit: offline reanalysis', '',
             'Costs are USD. No paid API calls were made. This is reanalysis, not a new experimental run.', '',
             '## Real rounds', '',
             '| Round | Events | Text tokens complete | Audited USD | Provider USD | Difference USD |',
             '|---|---:|---:|---:|---:|---:|']
    for label, row in result['real_rounds'].items():
        lines.append(f"| {label} | {row['audit_events']} | {row['complete_text_tokens']}/{row['text_events']} | {row['audited_usd']} | {row['provider_usd']} | {row['divergence_usd']} |")
    lines += ['', '## Client outcomes and measured latency', '',
              '| Round | Outcomes | Measured latencies | p50 ms | p95 ms |', '|---|---|---:|---:|---:|']
    for label, row in result['call_rounds'].items():
        outcomes = ', '.join(f'{k}: {v}' for k, v in row['outcomes'].items())
        lines.append(f"| {label} | {outcomes} | {row['measured_latencies']} | {row['p50_ms']} | {row['p95_ms']} |")
    b = result['b_recorded_provider_comparison']
    f = result['simulated_insert_failure']
    lines += ['', '## Recorded provider comparison', '',
              f"B text generations: {b['text_generations']}; exact cost matches: {b['exact_cost_matches']}; exact native token matches: {b['exact_token_matches']}.",
              f"B provider text total: USD {b['provider_text_usd']}; derived image share: USD {b['image_usd_derived_from_round_minus_text']}.", '',
              '## Simulated INSERT failure', '',
              f"Identical call outcomes: {f['identical_call_outcomes']}/640; recorded persisted events: {f['recorded_persisted_audit_events']}; missing audit events: {f['missing_audit_events']}.",
              f"Planned-successful calls completed: {f['planned_ok_completed']}/576.",
              'The 318 missing audit records were deliberately caused by rejected INSERTs, not by failed provider calls.', '',
              '## Limits', '',
              '- B was interrupted during call 637. Its reconstructed row has no client latency; only 639 B latencies are available.',
              '- The author attributes the interruption to the agent session limit. A memory-related cause recorded in the execution log was not independently established.',
              '- One real round per version; no causal isolation, replication variance or general latency overhead estimate.',
              '- Recorded provider reference fields are supplied evidence, not independently authenticated or newly fetched responses.',
              '- Raw service logs, simulated audit events and database dumps are not released. Trace-to-log coverage and every manuscript table cannot be recomputed from this package.',
              '- Application source, full load harness and simulator remain private; independent end-to-end reruns are not provided.', '']
    return '\n'.join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'generated')
    args = parser.parse_args()
    count = verify_manifest(ROOT)
    result = analyse(ROOT)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'summary.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    (args.output / 'report.md').write_text(render_report(result), encoding='utf-8')
    print(f'Verified {count} SHA-256 entries; reanalysed 1280 events and 3200 calls offline.')
    print(f'Results: {args.output.resolve()}')


if __name__ == '__main__':
    main()
