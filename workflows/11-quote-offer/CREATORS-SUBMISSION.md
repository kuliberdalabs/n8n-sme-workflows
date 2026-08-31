# n8n Creators submission — Quote and Offer Workflow

## Upload

`workflow-annotated-v2.json`

SHA-256: `c7677127b8a5df30fa8c26586bd9d6f3ee9564776aa4598e5a3edf0628de636b`

## Title

Create itemized quotes with Gmail and n8n Data Tables

## Short description

Price one-to-five-line quote bundles, preview optional offer variations, route exceptions for approval, and preserve delivery evidence.

## Categories

1. Sales
2. Finance

## Integrations

1. Gmail
2. n8n Data Tables
3. Webhook

## Description

# Build itemized service quotes from a controlled catalog

This workflow turns an authenticated quote request into an itemized fixed-price offer. A request can contain one to five unique service lines, or use the included legacy single-service shorthand. Four visible Code stages resolve a closed versioned catalog, calculate safe integer minor-unit totals, apply commercial review policy, and render an escaped HTML table with a stable pricing snapshot and hash.

Itemized bundles are sorted in catalog order before identity is derived. Sending the same services in a different order therefore replays the same durable request instead of creating another quote. Duplicate service codes, mixed shorthand and item arrays, extra item keys, fractional or unsafe quantities, and catalog-specific quantity violations fail before state or email.

The sample catalog contains an AI workflow audit, an automation operations retainer, a production workflow build, and an operations automation sprint. Unknown service codes can be recorded for human review, but the workflow returns no partial or guessed total and blocks approval until the catalog is deliberately extended.

The canvas also includes a disconnected manual customization lab. Its synthetic `example.test` fixture fans out to Good/Better/Best choices, a 40/60 deposit schedule, and a bounded CRM handoff payload. These are pure integer-safe previews: they use no credentials, variables, Data Tables, provider calls, or production edges. The CRM option explicitly returns `external_action_performed=false` and does not synchronize a CRM.

The production lanes preserve controlled delivery. Every request reads all rows in the exact durable scope before deciding whether to create, replay, or hold a conflict. Standard offers and review alerts persist their intent before Gmail. Client delivery is confirmed only when Gmail returns both a message id and thread id and the matching Data Table lifecycle update is acknowledged.

A separately authenticated approval webhook records approve or reject evidence and blocks expired, terminal, ambiguous, unverified-recipient, pending-send, and unknown-price rows. An hourly branch surfaces stale review and pending-email state and consumes its daily operator-alert bucket only after confirmed Gmail evidence.

## How it works

1. Authenticates one quote request and accepts either legacy `service_code + quantity` or one-to-five exact `line_items`, never both.
2. Canonicalizes line items in catalog order so reordered equivalent bundles share one deterministic submission id.
3. Resolves catalog entries, calculates line and quote totals in integer USD cents, applies review reasons, and renders escaped itemized HTML.
4. Persists `quote_mode`, `line_item_count`, canonical `line_items_json`, `pricing_snapshot_json`, and `pricing_snapshot_hash` with the quote.
5. Holds unknown services with no guessed total and prevents their approval.
6. Resolves replay or identity conflict across every exact Data Table match before writing send or review-alert intent.
7. Sends only to the normalized verified client address, while review and stale alerts use the controlled operations inbox.
8. Records approval or rejection through a separate token and confirms delivery only after provider plus durable update evidence.
9. Offers three isolated manual preview modules that can be inspected and adapted without performing payment or CRM actions.

## Setup

1. Create one n8n Data Table named `Quote_Offers` using the exact schema in the workflow README, then re-select it in every Data Table node.
2. Create separate n8n Variables named `QUOTE_INTAKE_TOKEN` and `QUOTE_APPROVAL_TOKEN`.
3. Connect Gmail to the four Gmail nodes.
4. Replace `ops@example.test` with a controlled operations inbox. Keep client recipients bound to the validated stored email.
5. Replace and version the sample catalog, currency, auto-send threshold, review phrases, itemized offer copy, expiry window, and stale thresholds.
6. Run `Try Quote Customizations` with the bundled synthetic fixture. Copy an optional transformation into your own reviewed branch only if you need it.
7. Keep the workflow inactive while testing shorthand compatibility, item boundaries, reorder replay, unknown services, approval, Gmail evidence, and stale alerts.

## Good to know

- This is a fixed-price example, not tax, accounting, legal, signature, payment, or commercial advice. The deposit option is a numeric schedule preview only.
- The CRM option builds a bounded payload only. It does not authenticate to, write to, or synchronize a CRM.
- n8n Data Tables do not provide an atomic unique constraint or transaction across lookup, write, and Gmail. Concurrent first deliveries or approvals can race.
- Gmail acceptance and Data Table acknowledgement are separate steps. A crash between them leaves explicit pending state for operator reconciliation; the workflow does not blindly resend.
- The hourly sweep reports stale state and throttles confirmed alerts by UTC day. Concurrent sweep executions can still duplicate an operator alert.
- Raw webhook bodies and tokens can appear in n8n execution history. Configure retention, pruning, and access controls appropriately.
- The template does not claim exactly-once email, legal acceptance, signature, payment collection, tax calculation, CRM synchronization, automatic recovery, or end-to-end sales fulfilment.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json`.
- [ ] Verify the upload hash is `c7677127b8a5df30fa8c26586bd9d6f3ee9564776aa4598e5a3edf0628de636b`.
- [ ] Confirm the canvas shows one yellow overview and eleven white narrative sections.
- [ ] Confirm the optional customization section contains exactly five nodes and has no edge to production.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select Gmail, n8n Data Tables, and Webhook as integrations if the portal asks for them.
- [ ] Use `Sales` and `Finance` as the categories.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
