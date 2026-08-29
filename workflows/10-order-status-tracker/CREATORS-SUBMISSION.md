# n8n Creators submission — Order Status Tracker

## Upload

`workflow-annotated-v2.json`

SHA-256: `5c41504135b3f8570913eeb111dfd4f091c86d3e515ad6fb43b2a023aec6eb0a`

## Title

Track customer order status with Gmail and n8n Data Tables

## Short description

Accept orders, enforce safe status transitions, deduplicate milestone alerts, expose a verifier-protected customer lookup, and surface stale notifications.

## Categories

1. E-commerce
2. Customer Support

## Integrations

1. Gmail
2. n8n Data Tables
3. Webhook

## Description

# Give customers a clear order status without rebuilding the story from email

This workflow gives a small commerce or fulfilment team one durable order-status record across intake, internal updates, milestone notifications, and customer lookup. It uses separate authenticated webhook lanes for creating an order and changing its status, so an intake payload cannot claim internal update authority.

Each order, explicit source event, transition, history entry, verifier, and milestone notification receives a deterministic key. Before evaluating a status, the workflow checks full Status History for its event key. Replays of accepted or previously-held events stop without another Order, History, Notification, or Gmail write, even after newer events changed the current Order. If an order validly re-enters an already-notified status under a new event id, the Order and History still advance, while only the repeated pending Notification and Gmail send are suppressed.

The internal status webhook accepts exactly one event object per request and requires an explicit event id and offset timestamp. Array-shaped, unknown, strictly older, regressive, out-of-sequence, or terminal-state updates are held with a reason rather than silently changing the customer-visible state. Valid changes pass an explicit allowed-edge matrix, check the notification ledger, and always persist the Order and Status History; only a new notification key continues to pending Notification and Gmail steps.

Customers can query a separate read-only webhook with their tenant, order id, and per-order verifier. A match returns only the order id, visible status, update time, and a safe message. Internal notes, names, line items, hashes, history, and email identifiers remain outside the response. A scheduled branch also alerts the operations inbox when a notification has remained pending for at least two hours.

## How it works

1. Authenticates the order-intake webhook with the server-side `ORDER_INTAKE_TOKEN`.
2. Validates the required tenant, order id, explicit source event id, initial state, explicit-offset event timestamp, and an unpadded 24–256 character per-order lookup secret.
3. Derives stable keys, checks for an existing Order, and returns duplicate intake without another side effect.
4. Persists a new Order, Status History row, and pending Notification row before sending a controlled Gmail message.
5. Authenticates one internal status event per request with the separate `ORDER_STATUS_TOKEN`, rejects array payloads, joins the event to its Order, and reads all matching Status History rows before classification.
6. Returns accepted or held event replays without another write, then holds new older events, applies the allowed-edge matrix, persists each valid transition, and checks every matching Notifications ledger row before creating another notification or email.
7. Records Gmail success or explicit `Pending Send` failure state in both Notifications and Orders.
8. Serves the verifier-protected safe lookup and runs a scheduled stale-pending alert for operators.

## Setup

1. Create n8n Data Tables named `Orders`, `Status History`, and `Notifications` with the columns listed in the workflow README, then re-select the correct table in every Data Table node.
2. Create distinct n8n Variables `ORDER_INTAKE_TOKEN` and `ORDER_STATUS_TOKEN`.
3. Connect a Gmail credential to the three Gmail nodes.
4. Replace `ops@example.com` with a controlled operations inbox. The template does not take the Gmail recipient from webhook data and does not email the customer directly.
5. Generate a distinct random 24–256 character lookup secret for each order, and review the status vocabulary, allowed transitions, equal-timestamp policy, customer-safe messages, notification copy, two-hour stale threshold, and schedule.
6. Keep the workflow inactive while testing. Use synthetic data to exercise wrong tokens, weak or padded lookup secrets, missing event ids, array payloads, first intake, replay of older accepted and previously-held events, allowed re-entry, lookup success and failure, Gmail failure, and stale rows.

## Good to know

- Intake requires an unpadded 24–256 character per-order lookup secret. It is still not a complete customer identity system, rate limiter, or signed expiring link.
- n8n Data Tables do not provide an atomic unique constraint across lookup, multiple writes, and Gmail. Concurrent first deliveries can race; use a transactional store with unique keys when that risk matters.
- The Order, History, Notification, Gmail, and acknowledgement steps are not one transaction. Partial state can require operator reconciliation.
- Gmail failure leaves explicit `Pending Send` state for the scheduled visibility check. The workflow does not automatically resend, and the stale operator alert has no throttle ledger.
- Milestone dedup suppresses only the repeated notification side effect: a valid re-entry still updates Order and History, but does not insert or send another notification unless you version the policy.
- Raw webhook bodies and tokens can appear in n8n execution history. Configure retention, pruning, and access controls for your privacy requirements.
- One token authorizes its whole lane. Add tenant-specific authorization if mutually untrusted tenants share one workflow.
- This template does not include a commerce-platform, inventory, carrier, or customer-portal adapter and does not claim exactly-once execution or guaranteed email delivery.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json`.
- [ ] Verify the upload hash is `5c41504135b3f8570913eeb111dfd4f091c86d3e515ad6fb43b2a023aec6eb0a`.
- [ ] Confirm the canvas shows one yellow overview and nine white section backgrounds.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select Gmail, n8n Data Tables, and Webhook as integrations if the portal asks for them.
- [ ] Use `E-commerce` and `Customer Support` as the categories.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
