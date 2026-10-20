# Data dictionary

UTF-8 CSV with a header. Empty fields mean **missing/not supplied**, never numeric zero. `True`/`False` are the CSV boolean literals. USD values must be parsed with decimal arithmetic. Dates are UTC. Request/generation identifiers are package-local pseudonyms, consistently remapped across inputs; original operational IDs and the remapping table are not released.

## Audit events: `ai_usage_events_A_B.csv`

| Fields | Meaning |
|---|---|
| `round` | Real A baseline or real B instrumented round |
| `occurred_at_utc` | Audit-event timestamp |
| `user_pseudo`, `user_role` | Synthetic-account pseudonym and role |
| `domain`, `feature`, `action` | Audit classification and operation |
| `route_template` | Route pattern without course/mission UUID values |
| `model_provider`, `model_name` | Recorded provider/model; naming aliases are preserved |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | Recorded token counts; absent fields are not inferred |
| `cost_usd`, `estimated_cost_usd` | Recorded monetary fields; cost takes precedence over estimate |
| `failed_attempts_cost_usd` | Separately recorded cost of earlier attempts, if supplied; absent treated as zero only for cost aggregation |
| `latency_ms` | Latency recorded by the application audit event, not client latency |
| `success`, `error_code` | Recorded operation outcome |
| `request_id`, `generation_id` | Consistent package-local pseudonyms of B correlation IDs; image responses have no generation ID |
| `usage_reported` | True if usage was reported; empty can mean an unpopulated flag, not proof of provider omission |
| `attempt_count` | Recorded count; empty does not prove a retry |

A lacked the five B instrumentation columns; the public union CSV leaves these A values empty. Missing A token fields can reflect the use case not forwarding them. This dataset cannot establish elimination of ambiguous zeros: no successful real call exercised missing provider usage.

An event is token-complete when prompt/completion are present and are not an ambiguous all-zero count without `usage_reported=True`. Images are excluded from the token-completeness denominator. A cost is complete when its recorded cost/estimate is present and not an ambiguous zero. Total audited cost sums the selected cost plus separately recorded failed-attempt costs.

## Client calls: `calls_all_rounds.csv`

| Fields | Meaning |
|---|---|
| `round`, `seq` | Round label and original 1–640 plan position |
| `ts_start_utc`, `ts_end_utc` | Client start/end timestamps, if recorded |
| `flow`, `action` | Logical flow and audit action |
| `user_pseudo` | Synthetic-account pseudonym |
| `planned_kind` | `ok` or `provoked_failure`; real mode did not inject the planned faults |
| `failure_mode`, `failure_attempts_armed` | Planned simulated failure and arming configuration; not an observed retry count |
| `http_status`, `outcome`, `error_code` | Client-observed HTTP/SSE result |
| `latency_ms` | Total measured client latency; missing for reconstructed B call 637 |
| `request_id` | Technical correlation identifier where available |
| `reconstructed` | `True` only for B call 637; its client fields were reconstructed from server records |

Rounds A and B used the real provider. B-mock, B-audit-off and B-db-fail used a simulated provider. Do not pool these populations to estimate real-provider error rates or latency. In B-db-fail, missing audit rows represent deliberately rejected writes, not failed logical calls.

## Supplied evidence

`provider_reference.json`: aggregate key-usage readings before/after each real round, recorded aggregate cost, and selected provider-side fields of 600 B text generations. No secret or management-account object is included. Image cost can be derived independently from these records only in B (round total minus the text-generation sum).

`simulated_audit_counts.json`: selected counts from saved summaries; raw simulated audit rows and metrics scrapes are not included. Its 322 persisted rows / 318 rejected writes are recorded evidence, not counts newly derived from a released database. The client result equivalence and planned-successful completions are recomputed from the public call CSV.
