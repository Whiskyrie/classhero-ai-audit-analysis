# v1.1.0 — integrated evaluation of version C

Adds, without changing any v1.0.0 file content except documentation and metadata:

- `integrated-c/`: provider simulator with 30 self-tests; harness scripts of the integrated evaluation (published for inspection; they need the private application); two synthetic run packages of two runs each, the final one (ClassHero commit `9a1b5066`, 28/28 criteria in both runs) and the pre-fix one (26/28 in both runs); harness tables `QUADRO.md`/`quadro.json`.
- `integrated_c.py`: standard-library recheck that recomputes every verdict from raw outputs (30 checks per run, two stricter than the harness) and compares with the harness table.
- `tests/test_integrated_c.py`: recheck regression, five negative controls on corrupted copies, simulator self-tests.
- `properties/`: recorded outcome of the 17 deterministic property tests, B 7/17 and C 17/17.

Finding documented: the administrative report of C omitted the charged cost of failed attempts in its per-model, daily, per-endpoint and per-user breakdowns and flagged a model as free when any of its events had zero or unknown cost. The integrated evaluation found it; the property tests did not. It was fixed in ClassHero commit `9a1b5066`.

Still private: application source, property spec, C patches, B-to-C diff, composition-probe spec, raw service logs.

Known limits: simulated provider; artificial composition in E1.2 to E1.4; two runs on one machine; no latency or load measurement.

# v1.0.0 — data and offline analysis

Initial separately licensed release of the ClassHero AI-audit analysis artifact.

Includes 1,280 real-round audit events, 3,200 client call rows, the historical workload, field-filtered provider/counter references, a standard-library-only offline analysis, regression tests, generated result summaries, provenance and SHA-256 checksums.

Known limits: one real round per version; interrupted/resumed B; no full end-to-end rerun harness or private application; recorded references are not newly authenticated provider data. The 318 B-db-fail losses are injected audit-write failures, not real provider-call failures.

Data/documentation: CC BY 4.0. New analysis/test code: MIT. No DOI is assigned.
