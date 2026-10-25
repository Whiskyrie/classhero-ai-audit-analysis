# ClassHero AI audit — data and offline analysis

Version **1.1.0**. Public analysis artifact accompanying the ClassHero AI-usage auditing study. This is a separate repository; it does **not** expose the private ClassHero application.

v1.1.0 adds the integrated evaluation of version C (provider simulator, harness scripts, synthetic run outputs, result tables and an offline recheck) and the recorded outcome of the deterministic property tests B against C. See `integrated-c/README.md` and `properties/README.md`. Everything released in v1.0.0 is unchanged.

## Run the analysis

Requires **Python 3.10 or newer**, standard library only. No installation, API key, Docker, database, private module or paid model call is needed.

```bash
git clone https://github.com/Whiskyrie/classhero-ai-audit-analysis.git
cd classhero-ai-audit-analysis
python3 -m unittest discover -s tests -v
python3 analysis.py
python3 integrated_c.py
```

The script verifies `MANIFEST.json` and writes `generated/summary.json` and `generated/report.md`. Outputs are deterministic and can be compared with the committed `results/` files:

```bash
diff results/summary.json generated/summary.json
diff results/report.md generated/report.md
```

The same commands work after extracting the release ZIP; cloning is not required. The script resolves inputs relative to itself, not the caller's working directory. Run it from a writable checkout/extraction. An alternative output directory is accepted with `--output PATH`.

## Contents

| File | Scope |
|---|---|
| `data/ai_usage_events_A_B.csv` | 1,280 pseudonymized audit events: 640 real A and 640 real B |
| `data/calls_all_rounds.csv` | 3,200 client rows: 640 each from A, B, B-mock, B-audit-off and B-db-fail |
| `data/workload.json` | Historical workload definition; seed 20261019 |
| `evidence/provider_reference.json` | Whitelisted recorded aggregate key-usage readings and 600 recorded B text-generation references |
| `evidence/simulated_audit_counts.json` | Selected recorded audit-write counters, explicitly distinguished from recomputed client outcomes |
| `analysis.py` | New self-contained offline reanalysis entry point |
| `tests/test_analysis.py` | Unit, integrity and dataset regression checks |
| `integrated-c/` | v1.1.0: integrated evaluation of C: simulator, harness scripts, two synthetic run packages (final and pre-fix), `QUADRO.md` tables |
| `integrated_c.py` | v1.1.0: offline recheck of the integrated runs from raw outputs |
| `tests/test_integrated_c.py` | v1.1.0: recheck regression, negative controls and simulator self-tests (skipped without Node) |
| `properties/` | v1.1.0: recorded outcome of the 17 deterministic property tests, B 7/17 and C 17/17 |
| `results/` | Outputs generated from the shipped inputs, not invented examples |
| `PROVENANCE.json` | Source paths relative to the internal study tree and hashes; no host paths |
| `MANIFEST.json` | SHA-256 for the released files, excluding itself |
| `DATA_DICTIONARY.md` | CSV field meanings and null conventions |
| `CITATION.cff` | Dataset attribution and versioned citation |

The old internal JavaScript scripts of the real rounds are deliberately not copied: some depend on unreleased helper modules, raw logs, API credentials or database dumps. The real-round workload runner and the application source are **not** part of this release. The provider simulator and the integrated-evaluation harness are released from v1.1.0; the harness needs the private application to run and is published for inspection. The property spec, the C patches and the B-to-C diff remain private.

## What this release can verify

- Audit-event counts, completeness of cost/token fields and request-ID presence for the real rounds.
- Audited totals versus the recorded provider usage deltas using exact decimal arithmetic.
- Cost and native-token agreement for the 600 B text events against the supplied recorded provider reference fields.
- Client outcomes, nearest-rank latency percentiles and planned-successful completions across all five released rounds.
- Equality of all 640 simulated client outcomes with and without the injected audit-write failure.
- v1.1.0: every E1/E2 verdict of the integrated evaluation of C, recomputed from requests, simulator ledger, exported audit events, report responses and metric deltas; determinism across the two runs; the report defect in the pre-fix package and its absence after the fix.
- v1.1.0: the provider simulator behaviour, through its own tests.

Provider reference fields were extracted from saved experimental records. This package does not independently authenticate those records, re-query the provider or turn supplied records into new observations. Trace-ID **presence** is recomputable; linkage to unreleased service logs is not.

## Expected observations

| Metric | A real | B real |
|---|---:|---:|
| Audited events | 640 | 640 |
| Complete text-token records | 379/600 | 600/600 |
| Audited USD | 1.83261560 | 1.83978490 |
| Recorded provider USD | 1.83397940 | 1.83978490 |
| Client errors | 1 | 2 |
| Measured client latencies | 640 | 639 |

**The 318 missing audit events belong to B-db-fail, not to real provider-call failures.** A database trigger deliberately rejected audit INSERTs in that simulated pass. All 640 client outcome/HTTP/error-code triples match B-mock; all 576 calls planned to succeed completed. The recorded persisted-event count is 322. These counts demonstrate only the tested INSERT-failure scenario, not tolerance of every PostgreSQL outage.

## Interrupted B round

B was interrupted during call 637. The server completed and billed that call; the client row was reconstructed from server records, marked `reconstructed=True`, with `outcome=client_interrupted` and **no latency**. It was not called twice. Calls 638–640 ran after an approximately 17-minute gap. The application stack stayed up. The author attributes the interruption to the agent session limit; the memory-related technical explanation in the execution log was not independently verified.

The missing latency is not imputed or treated as zero. One real round per version, run order, provider variability and the interruption limit causal/latency conclusions. Exact accounting agreement is not a reduction in expenditure.

## Privacy and exclusions

Accounts were synthetic; e-mail addresses were nevertheless replaced with `user-001` through `user-025`. No real user records were processed. The package excludes e-mails, tax identifiers, passwords, API keys, key prefixes, account-management responses, full database dumps, raw service logs, event IDs, course/mission UUIDs, snapshots, metadata, error messages, request fingerprints and signed forms.

`request_id` and `generation_id` contain **package-local pseudonyms**, not original operational identifiers or access credentials. The same replacements are used consistently in events, calls and provider references, preserving joins. The mapping back to the original IDs is not released. Provider references are explicit field allowlists rather than copies of management responses. The workload file contains experiment configuration, not executable application code.

## Reproduction limits

This artifact supports **reanalysis of the included recorded observations**, not a full independent end-to-end rerun. The integrated runs of C cannot be re-executed without the private application; their outputs can be rechecked. It does not reproduce every manuscript table: simulated audit-event rows, raw trace logs and certain internal source inputs are not included. Recorded simulated persisted-event counters are labelled as supplied evidence; client outcomes are independently recomputed from the released CSV.

Historical evaluated application commits:

- A: `30f02e62f46530adecf1f9b8ec1136a4a0f015a5`.
- B: `196effba1aee75514000734afbb5bb875edc0dd6`.
- C (property tests): `b5dd3ee9076eb6728c7c2a987573f43c66feecdd`.
- C (integrated evaluation, after the report fix): `9a1b5066a2c552217f33115d8793fd44f008b225`.

These are provenance identifiers, not public source links or promises of access.

The workload byte hash is `e5a2209f07553cead9765bd068a678d2fbfbb7c4b2bf0194027864738f15174d`. Internal run metadata separately records `a8cb6cb33dcbd1537f11a29cc1fb7e8959902a20e48c378122c1db2531e577f2`, the hash of the parsed JSON serialized by the original JavaScript harness. They hash different representations.

## Citation and licensing

Use `CITATION.cff` or cite the authors, repository, version **v1.1.0** and its release URL. No DOI has been assigned; a GitHub release is not a DOI deposit.

- Data, evidence, results and documentation: **CC BY 4.0**.
- Newly provided Python scripts/tests: **MIT**.
- Private application source and institutional trademarks: **not included or licensed here**.

See `LICENSE`, `LICENSE-DATA.md` and `LICENSE-CODE.txt` for the exact scope. Licensing was authorized by the corresponding author. This release is not evidence of final manuscript approval by all coauthors.
