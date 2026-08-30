# Quote and Offer Workflow

An inactive, import-ready n8n workflow that accepts authenticated quote requests, calculates a fixed-price offer from a deterministic sample price book, sends eligible quotes only to a verified submitted address, routes exceptions to human review, and records approval or rejection decisions. It uses only native n8n nodes, Gmail, and one n8n Data Table.

## What it does

The workflow has three independent entrances:

1. `POST /webhook/quote-offer-intake` validates `x-quote-intake-token` (or the matching Bearer token) against the server-side `QUOTE_INTAKE_TOKEN`, normalizes one request object, and derives a deterministic price and offer.
2. `POST /webhook/quote-offer-approval` validates a separate `QUOTE_APPROVAL_TOKEN`, then records an explicit approve or reject decision for one exact durable quote scope.
3. An hourly UTC sweep surfaces review rows whose operator alert is unconfirmed, quotes that have remained in review for 24 hours, and client-email intents that have remained pending for two hours.

The request cannot provide a price, discount, recipient override, approval flag, or role. Money comes only from the embedded price book. The workflow does not use AI for pricing or routing.

## Intake contract

Send exactly one object:

```json
{
  "onboarding_id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "smoke_tag": "ONBOARDING-DRAFT",
  "client_name": "Ada Example",
  "company": "Example Company",
  "email": "ada@example.test",
  "verified_email": "ada@example.test",
  "service_code": "workflow_build",
  "quantity": 1,
  "request_details": "Build and hand over one production workflow.",
  "request_text": "Build and hand over one production workflow."
}
```

`onboarding_id` must be a lowercase 64-character SHA-256 hex value. `smoke_tag` must be an exact, unpadded 1–80 character value matching `[A-Za-z0-9][A-Za-z0-9._-]*`. Both request-detail fields may be supplied for workflow 08 compatibility, but if both are present they must normalize to the same text. Object-valued strings, arrays, batch wrappers, missing identity, and out-of-range quantities fail closed before any Data Table or Gmail node. A syntactically bounded but unknown service is durably recorded as `Needs Review` with zero price and cannot be approved until the price-book entry is added; the workflow does not guess a price.

The client address is eligible for a send only when `email` and `verified_email` normalize to the same valid address. A missing or different `verified_email` creates `Needs Review`; it never sends to either address. Caller fields such as `send_to`, `recipient`, `discount`, `client_type`, or `force_review` are ignored and never persisted.

## Deterministic sample price book

The workflow embeds `QUOTE_SAMPLE_V1_2026-08-30` in the `Normalize Quote Request` Code node. Amounts use integer USD cents.

| Service code | Sample service | Unit net | Quantity |
|---|---|---:|---:|
| `ai_audit` | AI workflow audit | USD 1,800.00 | exactly 1 |
| `automation_retainer` | Automation operations retainer | USD 1,500.00 | 1–6 |
| `workflow_build` | Production workflow build | USD 3,200.00 | 1–3 |
| `ops_sprint` | Operations automation sprint | USD 4,800.00 | 1–2 |

Quotes above USD 5,000 net, recipient mismatches, discount language, legal/procurement terms, and unusual delivery or SLA language route to review. Replace the sample amounts, currency, automatic-send threshold, review vocabulary, offer HTML, and expiry period before production use. Keep calculations in integer minor units and version the price book when changing output.

## Workflow 08 child compatibility

This workflow accepts the exact quote child contract emitted by `08-client-onboarding-saga`: `onboarding_id`, `smoke_tag`, `client_name`, `company`, `email`, `verified_email`, `service_code`, `quantity`, `request_details`, and `request_text`.

It derives the parent-compatible business key exactly as:

```text
submission_id = sha256(lowercase(
  onboarding_id + "\n" +
  email + "\n" +
  service_code + "\n" +
  quantity + "\n" +
  request_details
))
```

The durable lookup is always scoped by all three fields: `submission_id + onboarding_id + smoke_tag`. It reads every matching physical row. Zero rows creates one new intent, one matching row is evaluated, and two or more rows stop as `ambiguous_duplicate_scope`; the workflow never silently takes the first row.

The parent formula intentionally omits some fields that can still change the generated offer or review path. A separate `request_fingerprint` covers the exact owner/run scope, client and company, both normalized addresses, service, quantity, request details, and price-book version. Reusing the same parent-compatible `submission_id` with a different fingerprint returns `submission_identity_conflict` with no new row or Gmail send. Exact replay also performs no new write or send.

Rows expose parent-compatible `status` values: `Offer Sent` only after validated client Gmail evidence, and `Needs Review` for review, rejection, or expiry. `lifecycle_state` preserves the more precise pending, rejected, expired, and sent state.

## Safe ordering and delivery evidence

For an eligible standard quote, `Insert Standard Send Intent` persists `Offer Pending Email` / `Standard Send Pending` before Gmail. For a review quote, `Insert Review Alert Intent` persists `Needs Review` and a separate review-alert intent before the operations email. Each insert is acknowledged against the exact identity before the Gmail node can run.

`email_sent=true` and `status=Offer Sent` require both a non-empty Gmail message id and thread id. Missing provider evidence or a Gmail error leaves the row pending and visible to the scheduled sweep. A review alert uses only `review_alert_sent` plus its own message/thread fields; it never sets `email_sent` and never masquerades as a client offer delivery.

For each scheduled stale-alert group, `duplicate_scope_count` records how many physical rows must acknowledge the exact identity and pending bucket. Zero, partial, or excess acknowledgements stop before the operations Gmail node; an ambiguous two-row group therefore requires exactly two durable intent acknowledgements.

The workflow sends eligible standard and explicitly approved offers to the validated `email` stored from the authenticated intake. Review and stale-state alerts go only to `ops@example.test`. Recipient override fields from either webhook are not read.

## Approval contract

Send one object to the approval webhook with the separate `x-quote-approval-token`:

```json
{
  "submission_id": "64-lowercase-hex-characters",
  "onboarding_id": "64-lowercase-hex-characters",
  "smoke_tag": "ONBOARDING-DRAFT",
  "action": "approve",
  "approval_actor": "ops-reviewer",
  "approval_note": "Scope and terms confirmed.",
  "approval_event_id": "approval-event-1042",
  "approval_event_at_utc": "2026-09-02T10:00:00Z"
}
```

`action` is exactly `approve` or `reject`. The workflow reads all rows in the exact three-field scope and refuses missing or ambiguous state. It records `approval_actor`, bounded note, event id, and explicit-offset event time. Replaying the same approval event is a no-write, no-send response.

Approval is allowed only while `lifecycle_state=Needs Review`, before `expires_at_utc`, with a known price-book entry, and only when the stored submitted recipient is verified. Rejection persists `Rejected` without Gmail. An expired approval attempt persists `Expired` without Gmail. Approval first persists parent-safe `status=Offer Pending Email`, `lifecycle_state=Approval Send Pending`, and all approval evidence, verifies the durable acknowledgement, and only then sends the client offer. `Offer Sent` again requires both Gmail identifiers. Rejected, expired, unknown-price, already-sent, ambiguous, and email-pending rows cannot be approved or sent again.

An approval event also has a derived fingerprint over its action, actor, note, id, and normalized event time. Reusing the same `approval_event_id` with exactly the same fingerprint is a no-write replay; reusing that id with changed approval content is `approval_event_identity_conflict` and cannot write or send.

## Data Table

Create one Data Table named `Quote_Offers`, then re-select it in every Data Table node. The JSON ships only with `REPLACE_WITH_QUOTE_OFFERS_TABLE_ID`. Create exported `dateTime` fields as `date` columns in the n8n UI.

### Quote_Offers schema

- Strings: `quote_key`, `submission_id`, `offer_submission_id`, `onboarding_id`, `smoke_tag`, `request_fingerprint`, `client_name`, `company`, `email`, `verified_email`, `service_code`, `service_label`, `request_details`, `price_book_version`, `currency`, `offer_number`, `offer_subject`, `offer_html`, `status`, `lifecycle_state`, `review_reason`, `email_provider_message_id`, `email_provider_thread_id`, `email_send_error`, `review_alert_provider_message_id`, `review_alert_provider_thread_id`, `review_alert_send_error`, `approval_action`, `approval_actor`, `approval_note`, `approval_event_id`, `approval_event_fingerprint`, `stale_alert_pending_bucket`, `stale_alert_sent_bucket`, `stale_alert_reason`, `stale_alert_provider_message_id`, `stale_alert_provider_thread_id`, `last_execution_id`
- Numbers: `quantity`, `unit_net_minor`, `total_net_minor`
- Booleans: `recipient_verified`, `has_price_book_entry`, `email_sent`, `review_alert_sent`
- Dates: `send_intent_at_utc`, `email_sent_at_utc`, `review_alert_intent_at_utc`, `review_alert_sent_at_utc`, `approval_event_at_utc`, `expires_at_utc`, `stale_alert_intent_at_utc`, `stale_alert_sent_at_utc`, `created_at_utc`, `updated_at_utc`

## Setup

1. Import `workflow.json` and keep it inactive.
2. Create `Quote_Offers` with the schema above, then select it in every Data Table node to replace the placeholder id.
3. Create distinct n8n Variables `QUOTE_INTAKE_TOKEN` and `QUOTE_APPROVAL_TOKEN`. If your plan does not support `$vars`, replace them with an equivalent server-side secret mechanism before activation.
4. Attach a Gmail credential to `Send Standard Client Offer`, `Send Quote Review Alert`, `Send Approved Client Offer`, and `Send Stale Quote Alert`.
5. Replace `ops@example.test` with a controlled operations inbox. Do not replace the client-recipient expressions with request-controlled override fields.
6. Customize and version the price book, currency, review bands, offer copy, expiry window, stale thresholds, schedule, and approval policy.
7. Keep the workflow inactive while testing with synthetic `example.test` addresses and isolated table rows.

## Synthetic test plan

- Missing, wrong, cross-lane, and correctly configured intake and approval tokens.
- Non-object and batch-shaped bodies; object-valued strings; padded or malformed scope values; unknown-service review; NaN, infinite, fractional, and out-of-bound quantity.
- Exact workflow 08 child payload and its expected `submission_id` formula across all four service codes.
- A standard quote, an amount review, a terms review, missing/mismatched `verified_email`, and ignored `send_to`, discount, role, and `force_review` fields.
- Exact replay; changed client/company/verified address under the same parent key; two identical and two conflicting physical rows in both input orders.
- Gmail success with both ids, Gmail error, message-id-only, and thread-id-only for standard, review-alert, approved-send, and stale-alert paths.
- Approval, rejection, expired attempt, repeated approval event, already sent, rejected, pending-send, unverified recipient, missing row, and ambiguous scope.
- Scheduled rows at both sides of the one-, two-, and 24-hour thresholds; an already-consumed daily bucket; zero, partial, exact, and excess grouped acknowledgements; Gmail failure followed by retry; success marking all rows in an explicitly grouped duplicate scope.
- Graph inspection proving intent-before-Gmail ordering, exactly one response node per webhook lane, fail-stop Data Table nodes, inactive state, placeholders, and no credentials or pinned data.

## Limits and residuals

- n8n Data Tables do not provide an atomic unique constraint or compare-and-set across lookup, insert/update, and Gmail. Concurrent first deliveries can both see zero rows, and concurrent approvals can race between read and intent update. Production systems with concurrent delivery should move `quote_key` and approval transitions to a transactional store with unique constraints.
- Gmail success and Data Table acknowledgement are not one transaction. A crash after Gmail accepts a message but before `Offer Sent` is persisted leaves a pending row that must be reconciled against provider evidence; the workflow deliberately does not auto-resend it. The same partial-state limit applies to review and stale alerts.
- The scheduled sweep reports stale states and uses a UTC-day bucket. It persists the candidate bucket before Gmail but moves it to `stale_alert_sent_bucket` only after both Gmail identifiers are present, so provider failures retry. Concurrent sweep executions can still duplicate an alert because the Data Table update is not an atomic claim.
- Duplicate physical rows are fail-closed in intake and approval. Observability groups identical durable scopes, reports the physical-row count, and updates the shared daily alert receipt across every exact match after provider success; it does not choose one row as truth.
- The workflow omits the older static-only follow-up lane. There is no customer follow-up automation until a separate design has durable suppression for rejection, expiry, reply, payment, cancellation, and provider acknowledgement.
- The embedded prices, review words, USD currency, tax omission, offer HTML, and 14-day expiry are examples, not legal or commercial advice. Adapt them to the operating entity and jurisdiction.
- One token authorizes its whole lane. For mutually untrusted tenants, add tenant-specific authentication and authorization rather than treating `onboarding_id` or `smoke_tag` as an access boundary.
- Webhook bodies can remain in n8n execution history even though only bounded whitelisted fields reach the Data Table. Configure execution retention, access control, and pruning for your privacy requirements.
- This template does not claim exactly-once email, legal acceptance, signature, payment, tax calculation, CRM synchronization, automatic recovery, or end-to-end sales fulfilment.
