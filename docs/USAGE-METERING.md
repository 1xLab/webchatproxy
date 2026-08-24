# Usage metering and cost planning

WebChatProxy persists consumption centrally, after the universal JobManager finishes a job. Provider facades (`3210..3240`) and the universal gateway (`3200`) therefore feed the same accounting layer.

## Persistent files

- `runtime/jobs/<job_id>.json`: complete operational job snapshot, including provider-returned `usage` when available.
- `runtime/usage/events.jsonl`: append-only normalized consumption ledger. One terminal usage event per job id.
- `runtime/usage/pricing.json`: optional operator-managed pricing table used only for cost estimation.

The ledger is the reporting source. Existing terminal jobs that predate the ledger are backfilled on gateway startup when their job files are loaded.

## Event dimensions

Every event records:

- `job_id`
- `provider`
- `model`
- `conversation_id`
- job terminal `status`
- `input_tokens`
- `output_tokens`
- `total_tokens`
- `cached_input_tokens`
- `reasoning_tokens`
- `duration_ms`
- optional estimated cost and currency
- job/create/start/finish/record timestamps

Failed, cancelled and interrupted jobs are also represented. If the provider supplies no token usage for such a job, token counters remain zero; the request still contributes to request/failure statistics.

## API

### Summary

`GET /v1/usage/summary`

Optional query parameters:

- `provider`
- `model`
- `conversation_id`
- `job_id`
- `from` ISO timestamp
- `to` ISO timestamp

Returns global totals plus `by_provider`, `by_model` and `by_conversation` aggregates. Provider facade ports automatically scope the result to their fixed provider.

### Raw normalized events

`GET /v1/usage/events?provider=kimi&limit=100`

### One job

`GET /v1/usage/jobs/<job_id>`

### One conversation/session

`GET /v1/usage/conversations/<conversation_id>`

These endpoints use the same bearer authentication as the gateway when `WEBCHAT_UNIVERSAL_API_TOKEN` is configured.

## Pricing

Pricing is deliberately not hard-coded because provider plans, promotional quotas and enterprise agreements change. Without a matching pricing entry, the ledger returns `cost.estimated = null` and summary `priced_requests` remains lower than `requests`.

Example `runtime/usage/pricing.json`:

```json
{
  "deepseek:deepseek-chat": {
    "currency": "USD",
    "input_per_million": 0.50,
    "cached_input_per_million": 0.10,
    "output_per_million": 1.50
  },
  "kimi:*": {
    "currency": "USD",
    "input_per_million": 0.00,
    "output_per_million": 0.00
  }
}
```

Keys are resolved in this order:

1. `provider:model`
2. `provider:*`

Rates are per one million tokens. Cached input uses `cached_input_per_million` when defined; otherwise the normal input rate is used.

## Frontend usage

A WebAgent dashboard can use:

- `summary.totals` for global planning;
- `summary.by_provider` for provider quota/abuse policy views;
- `summary.by_model` for model-level cost and consumption;
- `summary.by_conversation` for per-session attribution;
- `/v1/usage/jobs/:id` for job inspection;
- `/v1/usage/events` for detailed charts/audit.

`priced_requests / requests` is the cost-coverage ratio. A frontend should not present `estimated_cost` as complete unless these values are equal for the selected period.

## Abuse-policy inputs

The ledger intentionally persists more than tokens. Request counts, failures, cancellations, interruptions, duration, provider, model and session attribution allow later policy engines to implement limits such as:

- requests per provider per period;
- tokens per provider/model/session;
- maximum session consumption;
- abnormal failed-request rate;
- high-cost model usage;
- provider quota thresholds;
- user-facing planning/budget warnings once a caller/user dimension is added.

A future authenticated-user/account dimension can be added to each job/event without changing provider drivers, because accounting occurs centrally in the JobManager layer.
