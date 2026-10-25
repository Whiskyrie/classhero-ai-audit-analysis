# Deterministic property tests: B against C

`property-results-B-C.json` summarises the Jest JSON outputs of the 17 deterministic property tests run against ClassHero version B (`196effba`) and version C (`b5dd3ee9`). The tests use mocked `fetch` and a mocked database; no provider call. Test titles are kept in Portuguese, as in the spec.

| Version | Passed | Failed | Total |
|---|---:|---:|---:|
| B | 7 | 10 | 17 |
| C | 17 | 0 | 17 |

The ten tests failing in B are the expected defects (titles marked `[DEFEITO ESPERADO]`, plus the keyless no-guess test). The spec, the five C patches and the B-to-C diff are application code and are **not** released; this file is the recorded outcome only and is not independently re-executable here.

These tests did not catch the administrative-report breakdown defect described in `../integrated-c/README.md`: the property spec checks the summary SQL, not the breakdown queries.
