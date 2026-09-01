# Branded Client Report Draft Engine

An inactive, import-ready n8n workflow that accepts a bounded batch of already-supplied client report data, validates each client independently, renders deterministic tenant-branded HTML, and creates Gmail drafts without sending them. One n8n Data Table provides sequential replay suppression and durable lifecycle evidence. The workflow uses only native n8n nodes and does not fetch source data or use AI.

## What it does

`POST /webhook/client-report-intake` authenticates one exact batch with the server-side n8n Variable `CLIENT_REPORT_INTAKE_TOKEN`. The caller supplies one to 20 reports. Every report is validated independently, so an invalid client is summarized without blocking valid siblings.

For each valid report, the workflow:

1. Derives a SHA-256 `report_scope_key` from `tenant_id + report_period + template_version`.
2. Derives a privacy-preserving `recipient_hash`, deterministic `report_content_hash`, and exact `report_fingerprint`.
3. Renders escaped HTML with tenant branding, performance metrics or an explicit no-data state, highlights, risks, next steps, and source metadata.
4. Reads every physical Data Table row in the exact report scope.
5. Creates one `Draft Intent` only when the scope has no row.
6. Verifies exactly one matching intent acknowledgement before Gmail.
7. Creates a Gmail draft to the validated recipient. It never sends.
8. Persists `Draft Ready` only when Gmail returns a non-empty draft id. Missing provider evidence becomes `Draft Pending Reconcile`.
9. Verifies exactly one matching lifecycle update before returning the final per-report outcome.

The single webhook response summarizes every submitted report and never includes recipient addresses or report HTML.

## Authentication

Create an n8n Variable named `CLIENT_REPORT_INTAKE_TOKEN` with at least 16 characters. Send the same secret in exactly one of these forms:

```text
Authorization: Bearer <token>
```

or:

```text
x-client-report-intake-token: <token>
```

The workflow fails closed when the Variable is missing, too short, absent from the request, or different. Both supported authentication headers are removed before the request continues through the graph. One token authorizes the whole webhook lane; it is not tenant-level authorization.

## Exact batch contract

The webhook body must be an object with exactly `batch_id` and `reports`. `reports` must contain one to 20 objects.

This example uses only synthetic `.example` and `.example.test` data:

```json
{
  "batch_id": "batch-example-2026-08",
  "reports": [
    {
      "tenant_id": "tenant-example",
      "source_report_id": "crm-report-2026-08",
      "report_period": "2026-08",
      "client_name": "Ada Example",
      "recipient_email": "ada@example.test",
      "verified_recipient_email": "ada@example.test",
      "locale": "en-US",
      "brand_name": "Example Studio",
      "brand_color": "#3366AA",
      "source_updated_at_utc": "2026-08-31T10:00:00Z",
      "source_status": "complete",
      "metrics": {
        "leads": 40,
        "qualified_leads": 25,
        "proposals": 12,
        "won_deals": 5,
        "revenue_minor": 125000,
        "currency": "USD"
      },
      "highlights": [
        "Qualified demand improved."
      ],
      "risks": [
        "Proposal cycle remains long."
      ],
      "next_steps": [
        "Review stalled proposals."
      ]
    },
    {
      "tenant_id": "tenant-no-data-example",
      "source_report_id": "crm-report-2026-08-empty",
      "report_period": "2026-08",
      "client_name": "No Data Example",
      "recipient_email": "no-data@example.test",
      "verified_recipient_email": "no-data@example.test",
      "locale": "pl-PL",
      "brand_name": "Example Analytics",
      "brand_color": "#7A3E9D",
      "source_updated_at_utc": "2026-08-31T10:05:00+00:00",
      "source_status": "complete_no_data",
      "metrics": {},
      "highlights": [],
      "risks": [],
      "next_steps": []
    }
  ]
}
```

Every report must contain exactly these keys:

- `tenant_id`
- `source_report_id`
- `report_period`
- `client_name`
- `recipient_email`
- `verified_recipient_email`
- `locale`
- `brand_name`
- `brand_color`
- `source_updated_at_utc`
- `source_status`
- `metrics`
- `highlights`
- `risks`
- `next_steps`

Unknown or missing keys make only that report invalid.

### Scalar and array rules

- `batch_id`: unpadded 1–80 characters matching `[A-Za-z0-9][A-Za-z0-9._-]*`.
- `tenant_id`: lowercase, unpadded 1–64 characters matching `[a-z0-9][a-z0-9_-]*`.
- `source_report_id`: unpadded 1–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`.
- `report_period`: a real `YYYY-MM` month.
- `client_name`: unpadded string, 1–120 characters.
- Both email fields: unpadded valid addresses, at most 254 characters. They are normalized to lowercase and must be equal.
- `locale`: exactly `en-US` or `pl-PL`.
- `brand_name`: unpadded string, 1–100 characters.
- `brand_color`: exactly `#` plus six hexadecimal digits.
- `source_updated_at_utc`: parseable timestamp with an explicit `Z` or numeric offset. It cannot be in the future or older than 93 days.
- `source_status`: exactly `complete` or `complete_no_data`.
- `highlights`, `risks`, and `next_steps`: arrays of zero to 12 unpadded strings, each 1–300 characters.
- `tenant_id + report_period` must be unique within a batch. Every duplicate in that scope is rejected instead of choosing one.

Arrays and objects are rejected in scalar fields. Control characters are rejected in all bounded strings. Invalid scalar values are replaced with empty safe projections before any response is built, so oversized identifiers are not reflected. Array members must be strings; nested objects and nulls are not coerced.

### Metrics rules

For `source_status=complete`, `metrics` must have exactly:

- nonnegative finite safe integers: `leads`, `qualified_leads`, `proposals`, `won_deals`, `revenue_minor`
- a three-letter uppercase `currency`

The funnel must satisfy:

```text
leads >= qualified_leads >= proposals >= won_deals
```

Money remains integer minor units until rendering.

For `source_status=complete_no_data`, `metrics` must be exactly an empty object. The report renders an explicit no-data message. It never turns missing data into zero metrics.

## Deterministic identity and replay decisions

The template version is `CLIENT_REPORT_V1_2026-09-01`.

```text
report_scope_key = sha256(tenant_id + "\n" + report_period + "\n" + template_version)
recipient_hash = sha256(lowercase(validated_recipient_email))
report_content_hash = sha256(report_subject + "\n" + deterministic_report_html)
```

`report_fingerprint` covers the scope key, source id, normalized source timestamp, source status, recipient hash, and content hash.

The Data Table lookup returns all physical rows for the exact scope:

- zero rows → create one new intent
- exactly one row with the same fingerprint and confirmed `Draft Ready` plus a Gmail draft id → terminal replay with no write and no Gmail call
- exactly one row with a changed fingerprint → identity conflict with no write and no Gmail call
- exactly one row with the same fingerprint but pending, unknown, or partial state → reconcile required with no new draft
- two or more rows → ambiguous physical state, fail closed with no write and no Gmail call

The workflow never picks the first physical row and never automatically redrafts partial state.

## Data Table setup

Create one n8n Data Table named `Client_Report_Ledger`, then re-select it in all three Data Table nodes. The JSON contains only the placeholder:

```text
REPLACE_WITH_CLIENT_REPORT_LEDGER_TABLE_ID
```

Create these columns exactly:

### String columns

- `report_scope_key`
- `report_fingerprint`
- `report_content_hash`
- `recipient_hash`
- `tenant_id`
- `report_period`
- `source_report_id`
- `source_status`
- `lifecycle_status`
- `gmail_draft_id`
- `gmail_thread_id`
- `gmail_error`
- `batch_id`
- `execution_id`

### Date columns

- `source_updated_at_utc`
- `created_at_utc`
- `updated_at_utc`

The ledger intentionally excludes the raw webhook body, recipient address, report HTML, client name, brand fields, highlights, risks, and next steps. Those values exist only in the execution path needed to render the Gmail draft.

## Gmail setup

Attach one Gmail OAuth credential to `Create Gmail Report Draft`. Keep its operation as:

```text
resource: draft
operation: create
```

The recipient comes only from the equal, validated `recipient_email` and `verified_recipient_email` pair. The workflow has no Gmail send node.

## Setup

1. Import `workflow.json` and keep the workflow inactive.
2. Create `Client_Report_Ledger` with the exact schema above.
3. Re-select that table in `Find Existing Report Rows`, `Insert Report Draft Intent`, and `Update Draft Lifecycle`.
4. Create the `CLIENT_REPORT_INTAKE_TOKEN` n8n Variable.
5. Attach Gmail OAuth only to `Create Gmail Report Draft`.
6. Send synthetic test data with `.example.test` recipients.
7. Inspect Gmail drafts, ledger state, and the webhook summary before considering activation.
8. Configure execution retention and access controls for webhook privacy.

## Synthetic test plan

- Missing, too-short, wrong, Bearer, and dedicated-header tokens; confirm both auth headers are stripped.
- Exact one-report and 20-report batches; zero, 21, non-object, extra batch key, and malformed `batch_id`.
- Missing and extra report keys; object/array/null scalar values; unsafe lengths; invalid locale, color, email, source id, tenant, and period.
- Equal and mismatched verified recipients.
- Recent, stale, future, offset-based, and offset-free source timestamps.
- `complete` metrics with exact keys; null, empty, fractional, negative, unsafe, non-finite, extra-key, and funnel-order failures.
- `complete_no_data` with `{}` and with forbidden metric values.
- Empty and 12-entry narrative arrays; 13 entries, nulls, objects, padded strings, and HTML/script input.
- Duplicate tenant-period scopes alongside an unrelated valid sibling.
- Stable scope, recipient, content, and fingerprint hashes; changed content and recipient identity.
- Escaped HTML in both locales, explicit no-data rendering, and no AI claims.
- Zero-row new intent, exact replay, identity conflict, pending/unknown reconcile, and two-or-more-row ambiguity in either order.
- Zero, one, and two matching intent acknowledgements.
- Gmail draft id, missing id, error payload, and optional thread id.
- Zero, one, and two exact lifecycle update acknowledgements.
- A batch containing invalid, replay, conflict, reconcile, and new-draft outcomes.
- Static graph checks for inactive state, native nodes, one response, no credentials, no pinned data, placeholder table id, intent-before-draft order, and draft-only Gmail.
- Canonical-to-annotated behavioral parity.

## Limits and residuals

- The webhook data is supplied and validated; this workflow does not fetch CRM, analytics, finance, or other source systems.
- The workflow creates Gmail drafts but never sends them. A human must review and send each draft.
- The output is deterministic HTML email. It does not generate a PDF or another attachment.
- n8n Data Tables provide sequential replay suppression here, not an atomic unique constraint, lock, compare-and-set, or transaction. Concurrent first deliveries can both observe zero rows and create duplicate intents or drafts. Use a transactional store with a unique scope constraint when concurrent delivery is possible.
- Gmail and the Data Table are separate systems. A crash after Gmail creates a draft but before the lifecycle update is acknowledged leaves `Draft Intent` or `Draft Pending Reconcile`; the workflow deliberately does not create another draft automatically.
- Duplicate physical rows fail closed and require operator reconciliation.
- The 93-day source freshness window covers a current monthly report plus a bounded quarterly backfill. Change it deliberately if a different reporting horizon is required.
- One shared token protects the whole lane. Add tenant-level authentication and authorization for mutually untrusted tenants.
- Raw webhook requests and authorization data may remain in n8n execution history even though auth headers are stripped from downstream items and the Data Table stores privacy-minimal metadata. Configure retention, pruning, encryption, and access controls for the environment.
- The template makes no AI, anomaly detection, forecasting, PDF, exactly-once, atomic uniqueness, automatic send, or automatic reconciliation claim.
