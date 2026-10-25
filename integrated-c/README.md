# Integrated evaluation of version C (E1 and E2)

Released with v1.1.0. Every case ran the real path: HTTP client, ClassHero API (NestJS) at version C, content curator (Rust) at version C, a simulated OpenRouter provider and PostgreSQL. No paid model call and no real user data; accounts and courses were synthetic and the stack was discarded after each run.

## What is here

| Path | Content | Runnable here? |
|---|---|---|
| `mock-openrouter/` | Provider simulator and its 30 self-tests (`node --test server.test.js`) | Yes, Node 22 or newer |
| `harness/` | Scripts that drove the runs and built the table (`run-all.sh`, `run-public.mjs`, `run-composition.sh`, `build-report.mjs`, `lib/common.mjs`) | No: they need the private application, its stack scripts and the private composition spec. Published for inspection |
| `runs/20261025T200826Z/` | Final package: 2 consecutive runs against ClassHero commit `9a1b5066` | Recheck with `../integrated_c.py` |
| `runs/20261025T195549Z-pre-fix/` | Same harness, 2 runs, against the commit before the report fix | Recheck with `../integrated_c.py` |

## Oracle

The simulator is the ground truth. Each case injects a marker `[[probe:<id>]]` into a user input field. The simulator finds the marker in the prompt, applies the script for that marker (mode, cost, delay per attempt) and records one ledger row per generation: marker, `generation_id`, attempt, billed cost, cost reported in the response and finish order (`ledger.json`). Expected costs come from the script, not from the API. An audit event is correct when its `generation_id` belongs to the marker of the request that produced it and its cost equals the cost the simulator reported for that generation. Unknown cost (`null`) is never equal to zero.

Simulator modes used: `ok`, `no_usage` (charged, not reported), `free_cost_zero` (a real zero), `decode_error_charged` (charged response the curator cannot decode, forcing a retry) and `stream_abort` (usage arrives, then the connection drops).

## Cases

| Case | Path | Criterion |
|---|---|---|
| E1.1 | 5 concurrent public requests (text and SSE), staggered starts, inverted delays, distinct costs | One event per request with its own generation and cost; finish order inverse to start order; zero swaps |
| E1.2a | Composition probe: 4 real use cases in one request, inverse finish | Zero swaps; 4 correct |
| E1.2b | Concurrent calls, `save()` deferred and done in reverse finish order, with `call_id` key | Zero swaps; 4 correct |
| E1.2c | As E1.2b, without the key | Pairing refused: events without cost, marked `ambiguous_unpaired`; zero swaps |
| E1.2c control | E1.2c with keyless pairing temporarily replaced by FIFO (pre-C behaviour) | The check must report swaps (sensitivity) |
| E1.3 | SSE without usage beside a normal operation | Unknown only on its own event |
| E1.4 | Interrupted SSE (`stream_abort`) beside a normal operation | Failure event with its own attempt cost; zero swaps |
| E1.5 | 3 sequential public requests | Control |
| E2 | Public routes: known cost (a), charged retry (b), text without usage (c), real zero (d), SSE without usage (e) | Event vs oracle; `GET /admin/ai-costs` vs expected sums; API and curator `/metrics` deltas vs expected sums; no double counting; unknown outside `freeRequests`; report flags itself incomplete |
| E2.f | Window with unknown cost only | `freeRequests = 0`; per-model `isFree = false` |

## Recheck offline

```bash
python3 integrated_c.py                 # from the repository root
python3 -m unittest tests.test_integrated_c -v
```

`integrated_c.py` recomputes every verdict from `sent.json`, `ledger.json`, `events.json`, the report responses and the metric deltas. It does not read the harness verdicts except to compare with them at the end. It defines 30 checks per run: the 28 criteria of the harness table (`QUADRO.md`, `quadro.json`) plus two stricter ones it adds (`E2-rel-dia-endpoint-usuario`: daily, per-endpoint and per-user breakdowns sum to the total; `E2-rel-isFree`: per-model `isFree` in the mixed E2 window).

Expected output:

| Package | Failed checks per run | Divergence between runs | Disagreement with harness (28 shared) |
|---|---|---|---|
| `20261025T200826Z` | none | none | none |
| `20261025T195549Z-pre-fix` | `E2-rel-modelo`, `E2-rel-dia-endpoint-usuario`, `E2-rel-isFree`, `E2.f-rel-modelo-gratis` | none | none |

The pre-fix failures are one defect in the administrative report of C, found by this evaluation: the per-model, daily, per-endpoint and per-user breakdowns omitted the charged cost of failed attempts (per-model sum 0.0655 vs total 0.0777), and per-model `isFree` was true when any event of the model had zero or unknown cost. The harness table reports it as 26/28; the stricter recheck reports 4 of 30 checks failing. The fix is ClassHero commit `9a1b5066`.

The negative-control tests corrupt a copy of the final run (swapped generations, unknown written as zero, breakdown without the failed attempt, `isFree` on an unknown-only model, a guess in the keyless case) and require the recheck to fail.

## Per-run files (`run-N/`)

- `public/<case>/`: `sent.json` (requests and `x-request-id`), `ledger.json`, `events.json` (exported rows of `audit.ai_usage_events`), `result.json` (harness verdicts).
- `public/E2/`: also `admin-ai-costs.json`, `admin-ai-costs-only-unknown.json` and `metrics-delta.json` (scrape difference before and after, API and curator).
- `composition/composition-summary.json`: events, ledger and classification per probe case; `attempts.txt`.
- `mutant/`: the same for the FIFO control, and `mutant-control.json`.
- `exit-codes.txt`, `public.txt`, `mutant.txt`: harness console output.

Package root: `proveniencia.json` (ClassHero commit, tool versions, SHA-256 of the curator binary and simulator), `scripts.sha256` (harness scripts and private spec files, hashes only), `mock-openrouter-tests.txt`, `QUADRO.md` and `quadro.json` (harness table, in Portuguese).

## Sanitisation

Removed from the released runs: API, curator and stack logs, Jest console logs and the worktree status file. The single synthetic e-mail (`*@paper.test`) was replaced with `user-901`. Request IDs, generation IDs, event IDs and course IDs are kept: they are random values from a disposable synthetic database and the recheck joins on them. No credential, token or host path is present.

## Limits

- The composition of E1.2 to E1.4 is artificial: no production route makes two curator calls in one request. The probe exists only in the test module and shows the property for a future composition, not an active defect.
- In the probe, PostgreSQL is the e2e test container, not the stack database. Curator and simulator are the stack ones.
- The provider is simulated. Real OpenRouter behaviour (usage format, billing of failed attempts) is not tested here.
- The report is read over the whole window (`period=all`) on an events table cleaned at the start of E2. Period filters are not exercised.
- No latency or load measurement.
- Two runs show determinism of this harness on one machine, not across environments.
