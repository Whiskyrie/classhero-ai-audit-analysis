# v1.0.0 — data and offline analysis

Initial separately licensed release of the ClassHero AI-audit analysis artifact.

Includes 1,280 real-round audit events, 3,200 client call rows, the historical workload, field-filtered provider/counter references, a standard-library-only offline analysis, regression tests, generated result summaries, provenance and SHA-256 checksums.

Known limits: one real round per version; interrupted/resumed B; no full end-to-end rerun harness or private application; recorded references are not newly authenticated provider data. The 318 B-db-fail losses are injected audit-write failures, not real provider-call failures.

Data/documentation: CC BY 4.0. New analysis/test code: MIT. No DOI is assigned.
