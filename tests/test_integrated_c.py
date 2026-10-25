# SPDX-License-Identifier: MIT
"""Regression and negative-control tests for integrated_c.py; standard library only."""
import copy
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('integrated_c', ROOT / 'integrated_c.py')
ic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ic)

FINAL = ic.RUNS / '20261025T200826Z'
PRE_FIX = ic.RUNS / '20261025T195549Z-pre-fix'
REPORT_DEFECT = ['E2-rel-modelo', 'E2-rel-dia-endpoint-usuario', 'E2-rel-isFree', 'E2.f-rel-modelo-gratis']


def failed(results):
    return [c['id'] for c in results if not c['ok']]


class PackageTests(unittest.TestCase):
    def test_final_package_passes_every_check_in_both_runs(self):
        s = ic.verify_package(FINAL)
        self.assertEqual(s['runs'], ['run-1', 'run-2'])
        self.assertEqual(s['failed'], {'run-1': [], 'run-2': []})
        self.assertEqual(s['divergent_between_runs'], [])
        self.assertEqual(s['harness_criteria_shared'], 28)
        self.assertEqual(s['harness_disagreements'], [])

    def test_pre_fix_package_shows_only_the_report_defect(self):
        s = ic.verify_package(PRE_FIX)
        self.assertEqual(s['failed'], {'run-1': REPORT_DEFECT, 'run-2': REPORT_DEFECT})
        self.assertEqual(s['divergent_between_runs'], [])
        self.assertEqual(s['harness_disagreements'], [])

    def test_pre_fix_model_breakdown_omits_the_charged_failed_attempt(self):
        res = {c['id']: c for c in ic.verify_run(PRE_FIX / 'run-1')}
        self.assertEqual(sum(ic.num(x) for x in res['E2-rel-modelo']['observed']), ic.num('0.0655'))
        self.assertEqual(res['E2.f-rel-modelo-gratis']['observed'], [True])


class NegativeControls(unittest.TestCase):
    """Corrupt a copy of the final run and require the recheck to notice."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.rundir = self.tmp / 'run-1'
        shutil.copytree(FINAL / 'run-1', self.rundir)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def edit(self, rel, fn):
        p = self.rundir / rel
        data = json.loads(p.read_text(encoding='utf-8'))
        p.write_text(json.dumps(fn(copy.deepcopy(data))), encoding='utf-8')

    def test_clean_copy_passes(self):
        self.assertEqual(failed(ic.verify_run(self.rundir)), [])

    def test_swapped_generation_ids_are_detected(self):
        def swap(rows):
            case = next(c for c in rows if c['id'] == 'E1.2a')
            a, b = case['event_rows'][0], case['event_rows'][1]
            a['generation_id'], b['generation_id'] = b['generation_id'], a['generation_id']
            a['cost_usd'], b['cost_usd'] = b['cost_usd'], a['cost_usd']
            return rows
        self.edit('composition/composition-summary.json', swap)
        self.assertIn('E1.2a-identidade', failed(ic.verify_run(self.rundir)))

    def test_unknown_cost_written_as_zero_is_detected(self):
        def zero(events):
            for e in events:
                if e['cost_usd'] is None:
                    e['cost_usd'] = '0.00000000'
            return events
        self.edit('public/E2/events.json', zero)
        bad = failed(ic.verify_run(self.rundir))
        self.assertIn('E2.c-evento', bad)
        self.assertIn('E2.e-evento', bad)

    def test_breakdown_without_failed_attempt_is_detected(self):
        def drop(report):
            report['breakdownByEndpoint'][0]['costInUsd'] -= 0.0122
            return report
        self.edit('public/E2/admin-ai-costs.json', drop)
        self.assertEqual(failed(ic.verify_run(self.rundir)), ['E2-rel-dia-endpoint-usuario'])

    def test_free_flag_on_unknown_only_model_is_detected(self):
        def flag(report):
            report['breakdownByModel'][0]['isFree'] = True
            return report
        self.edit('public/E2/admin-ai-costs-only-unknown.json', flag)
        self.assertEqual(failed(ic.verify_run(self.rundir)), ['E2.f-rel-modelo-gratis'])

    def test_guess_in_keyless_case_is_detected(self):
        def guess(rows):
            case = next(c for c in rows if c['id'] == 'E1.2c')
            for row, led in zip(case['event_rows'], sorted(case['ledger'], key=lambda r: r['marker'])):
                row['generation_id'], row['cost_usd'], row['identity'] = led['generation_id'], led['reported_cost_usd'], None
            return rows
        self.edit('composition/composition-summary.json', guess)
        self.assertIn('E1.2c-identidade', failed(ic.verify_run(self.rundir)))


@unittest.skipUnless(shutil.which('node'), 'Node.js not installed')
class SimulatorTests(unittest.TestCase):
    def test_simulator_self_tests(self):
        r = subprocess.run(['node', '--test', 'server.test.js'], cwd=ROOT / 'integrated-c' / 'mock-openrouter',
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])


class PropertySummaryTests(unittest.TestCase):
    def test_property_counts(self):
        d = json.loads((ROOT / 'properties' / 'property-results-B-C.json').read_text(encoding='utf-8'))
        b, c = d['versions']['B'], d['versions']['C']
        self.assertEqual((b['passed'], b['failed'], b['total']), (7, 10, 17))
        self.assertEqual((c['passed'], c['failed'], c['total']), (17, 0, 17))
        self.assertEqual([t['title'] for t in b['tests']], [t['title'] for t in c['tests']])


if __name__ == '__main__':
    unittest.main()
