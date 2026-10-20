# ClassHero AI audit: offline reanalysis

Costs are USD. No paid API calls were made. This is reanalysis, not a new experimental run.

## Real rounds

| Round | Events | Text tokens complete | Audited USD | Provider USD | Difference USD |
|---|---:|---:|---:|---:|---:|
| A | 640 | 379/600 | 1.83261560 | 1.83397940 | -0.00136380 |
| B | 640 | 600/600 | 1.83978490 | 1.83978490 | 0.00000000 |

## Client outcomes and measured latency

| Round | Outcomes | Measured latencies | p50 ms | p95 ms |
|---|---|---:|---:|---:|
| A | done: 639, error: 1 | 640 | 3891 | 39026 |
| B | client_interrupted: 1, done: 637, error: 2 | 639 | 3835 | 37516 |
| B-audit-off | done: 589, error: 42, http_error: 9 | 640 | 47 | 3002 |
| B-db-fail | done: 589, error: 42, http_error: 9 | 640 | 50 | 3003 |
| B-mock | done: 589, error: 42, http_error: 9 | 640 | 49 | 3002 |

## Recorded provider comparison

B text generations: 600; exact cost matches: 600; exact native token matches: 600.
B provider text total: USD 0.43978490; derived image share: USD 1.40000000.

## Simulated INSERT failure

Identical call outcomes: 640/640; recorded persisted events: 322; missing audit events: 318.
Planned-successful calls completed: 576/576.
The 318 missing audit records were deliberately caused by rejected INSERTs, not by failed provider calls.

## Limits

- B was interrupted during call 637. Its reconstructed row has no client latency; only 639 B latencies are available.
- The author attributes the interruption to the agent session limit. A memory-related cause recorded in the execution log was not independently established.
- One real round per version; no causal isolation, replication variance or general latency overhead estimate.
- Recorded provider reference fields are supplied evidence, not independently authenticated or newly fetched responses.
- Raw service logs, simulated audit events and database dumps are not released. Trace-to-log coverage and every manuscript table cannot be recomputed from this package.
- Application source, full load harness and simulator remain private; independent end-to-end reruns are not provided.
