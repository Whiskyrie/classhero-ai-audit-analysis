# SPDX-License-Identifier: MIT
"""Unit and regression tests; standard library only; no network calls."""
import copy
import importlib.util
import json
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('analysis', ROOT / 'analysis.py')
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class UnitTests(unittest.TestCase):
    def test_nearest_rank_and_missing_latency(self):
        self.assertIsNone(analysis.percentile([], 50))
        self.assertEqual(analysis.percentile([5, 1, 3, 2, 4], 50), 3)
        self.assertEqual(analysis.percentile([5, 1, 3, 2, 4], 95), 5)
        with self.assertRaises(ValueError):
            analysis.percentile([1], 0)

    def test_money_is_decimal_not_binary_float(self):
        self.assertEqual(analysis.money(analysis.decimal('0.1') + analysis.decimal('0.2')), '0.30000000')
        self.assertEqual(analysis.decimal(''), Decimal(0))

    def test_empty_cost_is_not_complete(self):
        row = {'cost_usd': '', 'estimated_cost_usd': '', 'usage_reported': ''}
        self.assertFalse(analysis.has_cost(row))

    def test_zero_requires_usage_to_be_unambiguous(self):
        row = {'cost_usd': '0', 'estimated_cost_usd': '', 'usage_reported': ''}
        self.assertFalse(analysis.has_cost(row))
        row['usage_reported'] = 'True'
        self.assertTrue(analysis.has_cost(row))

    def test_missing_tokens_and_zero_semantics(self):
        row = {'prompt_tokens': '', 'completion_tokens': '1', 'total_tokens': '1', 'usage_reported': 'True'}
        self.assertFalse(analysis.has_tokens(row))
        row.update(prompt_tokens='0', completion_tokens='0', total_tokens='0', usage_reported='')
        self.assertFalse(analysis.has_tokens(row))
        row['usage_reported'] = 'True'
        self.assertTrue(analysis.has_tokens(row))

    def test_estimate_fallback_and_earlier_attempt_cost(self):
        row = {'cost_usd': '', 'estimated_cost_usd': '0.010', 'failed_attempts_cost_usd': '0.002'}
        self.assertEqual(analysis.event_cost(row), Decimal('0.012'))
        row['cost_usd'] = '0'
        self.assertEqual(analysis.event_cost(row), Decimal('0.002'))

    def test_unsafe_manifest_path_is_rejected(self):
        payload = json.dumps({'sha256': {'../outside.txt': '0' * 64}})
        with patch.object(Path, 'read_text', return_value=payload):
            with self.assertRaisesRegex(ValueError, 'Unsafe manifest path'):
                analysis.verify_manifest(ROOT)

    def test_corrupted_checksum_is_rejected(self):
        payload = json.dumps({'sha256': {'README.md': '0' * 64}})
        with patch.object(Path, 'read_text', return_value=payload):
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                analysis.verify_manifest(ROOT)


class DatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = analysis.analyse(ROOT)

    def test_all_release_checksums(self):
        self.assertGreater(analysis.verify_manifest(ROOT), 10)

    def test_operational_ids_are_replaced_consistently(self):
        events = analysis.read_csv(ROOT / 'data/ai_usage_events_A_B.csv', analysis.EVENT_COLUMNS)
        calls = analysis.read_csv(ROOT / 'data/calls_all_rounds.csv', analysis.CALL_COLUMNS)
        for row in events + calls:
            if row.get('request_id'):
                self.assertRegex(row['request_id'], r'^request-\d{6}$')
            if row.get('generation_id'):
                self.assertRegex(row['generation_id'], r'^generation-\d{6}$')
        event_ids = {r['request_id'] for r in events if r['round'] == 'B'}
        call_ids = {r['request_id'] for r in calls if r['round'] == 'B'}
        self.assertEqual(event_ids, call_ids)
        self.assertEqual(len(event_ids), 640)

    def test_real_counts_and_population(self):
        for label in ('A', 'B'):
            row = self.result['real_rounds'][label]
            self.assertEqual((row['audit_events'], row['text_events'], row['image_events']), (640, 600, 40))
        self.assertEqual(self.result['real_rounds']['A']['complete_text_tokens'], 379)
        self.assertEqual(self.result['real_rounds']['B']['complete_text_tokens'], 600)

    def test_recorded_cost_reconciliation(self):
        a, b = (self.result['real_rounds'][label] for label in ('A', 'B'))
        self.assertEqual(a['audited_usd'], '1.83261560')
        self.assertEqual(a['provider_usd'], '1.83397940')
        self.assertEqual(a['divergence_usd'], '-0.00136380')
        self.assertEqual(b['audited_usd'], '1.83978490')
        self.assertEqual(b['divergence_usd'], '0.00000000')

    def test_provider_text_comparison(self):
        row = self.result['b_recorded_provider_comparison']
        self.assertEqual((row['text_generations'], row['exact_cost_matches'], row['exact_token_matches']), (600, 600, 600))
        self.assertEqual(row['provider_text_usd'], '0.43978490')
        self.assertEqual(row['image_usd_derived_from_round_minus_text'], '1.40000000')

    def test_interrupted_row_remains_missing_not_zero(self):
        a, b = (self.result['call_rounds'][label] for label in ('A', 'B'))
        self.assertEqual(a['measured_latencies'], 640)
        self.assertEqual(b['measured_latencies'], 639)
        self.assertEqual(b['reconstructed_rows'], 1)
        self.assertEqual(b['outcomes'], {'client_interrupted': 1, 'done': 637, 'error': 2})
        calls = analysis.read_csv(ROOT / 'data/calls_all_rounds.csv', analysis.CALL_COLUMNS)
        row = next(r for r in calls if r['round'] == 'B' and r['seq'] == '637')
        self.assertEqual(row['latency_ms'], '')
        self.assertEqual(row['reconstructed'], 'True')

    def test_insert_failures_are_not_provider_call_errors(self):
        row = self.result['simulated_insert_failure']
        self.assertEqual(row['missing_audit_events'], 318)
        self.assertEqual(row['recorded_persisted_audit_events'], 322)
        self.assertEqual(row['identical_call_outcomes'], 640)
        self.assertEqual(row['planned_ok_completed'], 576)
        self.assertEqual(self.result['call_rounds']['B-mock']['outcomes'],
                         self.result['call_rounds']['B-db-fail']['outcomes'])

    def test_real_latency_regression(self):
        self.assertEqual(self.result['call_rounds']['A']['p50_ms'], 3891)
        self.assertEqual(self.result['call_rounds']['A']['p95_ms'], 39026)
        self.assertEqual(self.result['call_rounds']['B']['p50_ms'], 3835)
        self.assertEqual(self.result['call_rounds']['B']['p95_ms'], 37516)

    def test_fails_when_an_observed_outcome_is_changed(self):
        original = analysis.read_csv
        def changed(path, columns):
            rows = original(path, columns)
            if path.name == 'calls_all_rounds.csv':
                rows = copy.deepcopy(rows)
                next(r for r in rows if r['round'] == 'B-db-fail')['outcome'] = 'tampered'
            return rows
        with patch.object(analysis, 'read_csv', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'Simulated outcomes no longer match'):
                analysis.analyse(ROOT)

    def test_fails_when_token_reference_is_changed(self):
        real_loads = json.loads
        def changed(text, *args, **kwargs):
            value = real_loads(text, *args, **kwargs)
            if 'rounds' in value and 'B' in value['rounds'] and 'text_generations' in value['rounds']['B']:
                value['rounds']['B']['text_generations'].pop()
            return value
        with patch.object(analysis.json, 'loads', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'Nonunique/missing generation reference'):
                analysis.analyse(ROOT)

    def test_generated_outputs_match_committed_results(self):
        expected = json.loads((ROOT / 'results/summary.json').read_text())
        self.assertEqual(self.result, expected)
        self.assertEqual(analysis.render_report(self.result), (ROOT / 'results/report.md').read_text())


if __name__ == '__main__':
    unittest.main()
