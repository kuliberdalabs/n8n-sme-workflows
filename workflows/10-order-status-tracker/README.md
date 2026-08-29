# Order Status Tracker

An inactive, import-ready n8n workflow for accepting orders, applying controlled status transitions, recording accepted and held status evidence, deduplicating milestone notifications, and serving a deliberately narrow customer status lookup. It uses only native n8n nodes, Gmail, and three n8n Data Tables.

## What it does

The workflow has four separate entrances:

1. `POST /webhook/order-status-intake` creates a new order after authenticating `x-order-intake-token` (or the matching Bearer token) against the server-side `ORDER_INTAKE_TOKEN` variable.
2. `POST /webhook/order-status-update` applies internal status events after authenticating `x-order-status-token` against the separate `ORDER_STATUS_TOKEN` variable.
3. `POST /webhook/order-status-lookup` returns a safe customer projection only when `tenant_key`, `order_id`, and the per-order `customer_status_token` produce the stored verifier hash.
4. A scheduled sweep reports notification rows that have remained `Pending Send` for at least two hours.

Intake and status authority are physically separate. The intake branch is create-only and cannot reach the status transition builder. The status branch derives `source_role=internal` from its authenticated webhook instead of trusting a role supplied in the request body. The public lookup branch has no path to a Data Table write or Gmail node.

## Intake contract

Send an object such as:

```json
{
  "tenant_key": "example_store",
  "order_id": "ORDER-1042",
  "customer_name": "Ada Example",
  "customer_email": "ada@example.test",
  "customer_status_token": "replace-with-a-random-per-order-secret",
  "event_at_utc": "2026-09-01T09:00:00Z",
  "source_event_id": "commerce-event-1042",
  "status": "Received",
  "reason": "Order received",
  "line_items": []
}
```

`tenant_key`, `order_id`, `source_event_id` (or `event_id`), `customer_status_token`, and a real ISO timestamp with an explicit offset are required. The verifier must be an unpadded string of 24–256 characters; use an independently generated random secret per order. Initial status may be `Received` or `Confirmed`. A valid first intake writes the Order, History, and pending Notification records before Gmail is attempted. A duplicate `tenant_key + order_id` returns `duplicate_ignored` and does not write or send again. Invalid intake is recorded in Status History as held and never sends email.

## Status contract and transition policy

The status webhook accepts exactly one event object per request. It rejects an `events` field or any non-object body as a held `422` outcome, never expands a request into multiple responses, and never derives an event identity from a timestamp or array index. Each event requires `tenant_key`, `order_id`, `status`, `source_event_id` (or `event_id`), and an explicit-offset `event_at_utc`.

Before stale, transition, or hold evaluation, the workflow queries all Status History rows for the deterministic `event_key`. If any accepted or held row already has that key, the request returns `duplicate_ignored` with no Order, History, Notification, or Gmail write. This remains true after later events have replaced `Orders.last_event_key`, and it prevents a previously-held delivery from becoming actionable merely because the Order later entered a compatible state.

An event whose parsed timestamp is strictly older than the Order's stored `last_status_at_utc` is held and written to Status History without changing the visible state. A distinct event id at exactly the same timestamp is evaluated normally against the allowed-edge matrix; the workflow does not invent a secondary ordering for equal timestamps.

Allowed transitions are explicit:

| From | Allowed next states |
|---|---|
| `Received` | `Confirmed`, `Cancelled` |
| `Needs Clarification` | `Received`, `Confirmed`, `Cancelled` |
| `Confirmed` | `In Production`, `Blocked`, `Backordered`, `Cancelled` |
| `Blocked` | `Confirmed`, `In Production`, `Cancelled` |
| `Backordered` | `Confirmed`, `In Production`, `Cancelled` |
| `In Production` | `Quality Hold`, `Ready`, `Blocked`, `Backordered`, `Cancelled` |
| `Quality Hold` | `In Production`, `Ready`, `Cancelled` |
| `Ready` | `Shipped`, `Collected`, `Cancelled` |
| `Shipped` | `Collected`, `Cancelled`, `Lost / Closed` |
| `Collected`, `Cancelled`, `Lost / Closed` | none |

Unknown, strictly older, regressive, out-of-sequence, or terminal-state updates cannot silently advance the order; they are written to Status History with a reason and do not send. History-backed exact replays and unchanged updates stop without appending another history row. Notification keys are stable for `order + target status + transition version`. When a valid transition re-enters a status whose key already has sent evidence, the workflow still updates the Order and inserts the accepted Status History row, but it does not insert another pending Notification or send Gmail again.

## Customer lookup contract

Send `tenant_key`, `order_id`, and `customer_status_token` to the lookup webhook. A match returns only:

```json
{
  "order_id": "ORDER-1042",
  "customer_visible_status": "Ready",
  "updated_at_utc": "2026-09-01T11:00:00.000Z",
  "message": "Your order status changed to Ready."
}
```

Wrong, missing, or cross-order verifier values return the same `not_found` response. Internal status, names, notes, line items, email hashes, verifier hashes, event keys, notification rows, and Gmail identifiers are never included in the lookup response.

## Data Tables

Create three Data Tables, then re-select each one in all matching nodes. The JSON ships with explicit placeholder IDs:

- `REPLACE_WITH_ORDERS_TABLE_ID`
- `REPLACE_WITH_STATUS_HISTORY_TABLE_ID`
- `REPLACE_WITH_NOTIFICATIONS_TABLE_ID`

Create `dateTime` export fields as `date` columns in the n8n UI.

### Orders

- Strings: `order_key`, `order_id`, `tenant_key`, `customer_key`, `customer_name`, `customer_name_html`, `customer_email_hash`, `customer_verifier_hash`, `customer_visible_status`, `internal_status`, `source_channel`, `source_role`, `last_event_key`, `last_transition_key`, `last_notified_status`, `notification_status`, `last_notification_key`, `last_email_id`, `status_reason`, `status_reason_html`, `order_notes`, `order_notes_html`, `line_items_json`, `safe_projection_json`, `smoke_tag`, `last_execution_id`
- Numbers: `status_rank`, `oldest_open_age_hours`
- Dates: `pending_since_utc`, `created_at_utc`, `updated_at_utc`, `last_status_at_utc`

### Status History

- Strings: `history_key`, `order_key`, `order_id`, `event_key`, `event_type`, `from_status`, `to_status`, `action`, `source_role`, `source_channel`, `reason`, `reason_html`, `notification_key`, `smoke_tag`, `last_execution_id`
- Dates: `event_at_utc`, `created_at_utc`

### Notifications

- Strings: `notification_key`, `order_key`, `order_id`, `controlled_recipient`, `intended_recipient_hash`, `recipient_mode`, `status`, `status_before_send`, `delivery_status`, `send_error`, `email_subject`, `email_body_html`, `test_email_id`, `smoke_tag`, `last_execution_id`
- Number: `status_rank`
- Boolean: `email_sent`
- Dates: `created_at_utc`, `updated_at_utc`

## Setup

1. Import `workflow.json` and keep it inactive.
2. Create the three Data Tables with the columns above, then replace every placeholder by selecting the correct table in each Data Table node.
3. Create distinct n8n Variables `ORDER_INTAKE_TOKEN` and `ORDER_STATUS_TOKEN`. Variables require a plan that supports `$vars`; otherwise replace them with an equivalent server-side secret mechanism before activation.
4. Attach a Gmail credential to `Send Controlled Intake Status Email`, `Send Controlled Status Update Email`, and `Send Controlled Stale Alert`.
5. Replace `ops@example.com` with a controlled operations inbox. The template never takes a recipient address from the webhook and does not send directly to the customer.
6. Review the status vocabulary, allowed-edge matrix, notification wording, two-hour stale threshold, and schedule before activation.
7. While inactive, use synthetic `example.test` data to test wrong lane tokens, weak or padded verifiers, missing event ids, status arrays, a new intake, exact replay, older/equal-time/allowed/blocked transitions, lookup success and failure, Gmail failure, and stale pending rows.

## Residuals and limits

- n8n Data Tables do not provide an atomic unique constraint or compare-and-set across lookup, row writes, and Gmail. Concurrent first deliveries can both observe no existing row. For production concurrency, move the three stable keys (`order_key`, `history_key`, `notification_key`) to a store with unique constraints or transactional upserts.
- Order, History, Notification, Gmail, and post-send updates are not one transaction. A failure after an Order update but before later writes can leave partial state. The stale sweep makes `Pending Send` visible, but it does not repair rows or resend automatically; operators must reconcile the durable rows before retrying.
- If Gmail fails or returns no message identifier, the workflow keeps `notification_status=Pending Send` and does not mark the order as notified. It has no automated resend worker. The stale-alert email itself has no throttle ledger, so an unresolved old row can produce another operator alert on a later sweep.
- Notification dedup is milestone-level and suppresses only the repeated side effect. After a status has one sent ledger row, moving away and later returning still persists the valid transition and History, but does not insert or send another notification unless you intentionally version the notification-key policy.
- Intake enforces a 24–256 character unpadded per-order verifier, but the lookup is still not an end-user identity provider, rate limiter, or signed expiring link. Put the webhook behind suitable transport controls and monitoring for your threat model.
- Raw webhook bodies, tokens, customer names, order notes, and line items can appear in n8n execution history even though the public response is a safe projection and customer email is stored only as a hash. Configure execution retention, access controls, and pruning for your privacy obligations; avoid storing unnecessary personal data.
- One token authorizes its whole lane. If one workflow serves mutually untrusted tenants, add tenant-specific authentication and authorization rather than treating `tenant_key` alone as an access boundary.
- The template does not connect to a commerce platform, carrier, customer portal, or inventory system. Those adapters must preserve the documented identity and timestamp contracts.
- It does not claim exactly-once execution, guaranteed email delivery, automatic resend, customer identity verification, delivery proof, or end-to-end order fulfilment.
