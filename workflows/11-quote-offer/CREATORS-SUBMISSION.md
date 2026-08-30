# n8n Creators submission — Quote and Offer Workflow

## Upload

`workflow-annotated-v2.json`

SHA-256: `c80dcb22b3b98610a64643b1aa3e2e519c58c00c9ecf045b37afb6393517b436`

## Title

Create fixed-price quotes with Gmail and n8n Data Tables

## Short description

Price authenticated quote requests, prevent replay sends, route exceptions for approval, and surface stale delivery state.

## Categories

1. Sales
2. Finance

## Integrations

1. Gmail
2. n8n Data Tables
3. Webhook

## Description

# Turn a qualified request into a controlled fixed-price offer

This workflow gives a service business a durable path from an authenticated quote request to a fixed-price offer, human review, approval or rejection, and delivery evidence. It uses a deterministic sample price book instead of AI, so the same accepted inputs always produce the same money calculation.

The intake webhook accepts exactly one bounded request object. It derives a parent-compatible submission id and a broader request fingerprint, then reads every matching Data Table row before deciding what to do. An exact replay performs no write and sends no email. A changed request under the same parent id is held as an identity conflict, while duplicate physical rows fail closed instead of silently selecting the first result.

Four sample services are included: AI workflow audit, automation operations retainer, production workflow build, and operations automation sprint. Quotes above the sample automatic-send threshold, custom discount or legal language, unknown service codes, and missing or mismatched verified addresses move to `Needs Review`. Unknown services receive no guessed price and cannot be approved until the price book is extended.

Eligible standard quotes persist `Standard Send Pending` before Gmail. Review cases persist a separate operator-alert intent and email only the controlled operations inbox. The independent approval webhook supports explicit approve and reject decisions, expiry checks, and durable actor, note, event, and timestamp evidence. An approved quote persists `Approval Send Pending` before it can reach Gmail.

Client delivery is confirmed only when Gmail returns both a message id and thread id and the corresponding Data Table update acknowledges exactly one matching row. Review-alert delivery has separate fields and never marks the client offer sent. An hourly branch surfaces stale review and email-pending states, including ambiguous duplicate scopes. It requires exactly the declared physical-row count to acknowledge stale-alert intent before Gmail, then consumes its daily alert bucket only after confirmed delivery.

## How it works

1. Authenticates quote intake with the server-side `QUOTE_INTAKE_TOKEN` and rejects malformed, array-shaped, padded-scope, or out-of-range requests before state access.
2. Calculates integer USD cents from a versioned fixed price book and derives the exact workflow 08-compatible submission id plus a full request fingerprint.
3. Reads all rows in the `submission_id + onboarding_id + smoke_tag` scope to distinguish a new request, exact replay, identity conflict, or ambiguous duplicate.
4. Persists standard-send or review-alert intent and verifies the exact acknowledgement before Gmail.
5. Sends an eligible standard offer only when `email` and `verified_email` normalize to the same valid submitted address; otherwise it alerts only the operations inbox.
6. Authenticates approval separately with `QUOTE_APPROVAL_TOKEN`, records approve or reject evidence, and blocks expired, terminal, ambiguous, pending-send, unverified-recipient, and unknown-price rows.
7. Confirms an offer as sent only after Gmail provider evidence and an exact compare-and-set delivery acknowledgement.
8. Sweeps hourly for stale review or pending-email state and records alert intent and confirmed alert delivery in separate fields.

## Setup

1. Create one n8n Data Table named `Quote_Offers` using the exact columns in the workflow README, then re-select it in every Data Table node.
2. Create separate n8n Variables named `QUOTE_INTAKE_TOKEN` and `QUOTE_APPROVAL_TOKEN`.
3. Connect Gmail to the four Gmail nodes.
4. Replace `ops@example.test` with a controlled operations inbox. Keep the client-recipient expressions bound to the validated stored email; do not add request-controlled recipient overrides.
5. Replace and version the sample price book, currency, automatic-send threshold, review phrases, offer copy, expiry window, and stale thresholds for your business.
6. Keep the workflow inactive while testing wrong tokens, exact replay, identity conflict, ambiguous rows, standard delivery, review, approve, reject, expiry, partial Gmail evidence, failed durable acknowledgement, and stale alerts.

## Good to know

- This is a fixed-price sample, not tax, accounting, legal, signature, payment, or commercial advice. It does not include VAT or another tax calculation.
- n8n Data Tables do not provide an atomic unique constraint or transaction across lookup, write, and Gmail. Concurrent first deliveries or approvals can race; use a transactional store with unique keys when that risk matters.
- Gmail acceptance and Data Table acknowledgement are separate steps. A crash between them leaves explicit pending state for operator reconciliation; the workflow does not blindly resend.
- Review alerts and stale alerts are operational notifications, not client-offer sends. Their provider ids and sent flags remain separate from `email_sent`.
- The hourly sweep reports stale state and throttles confirmed alerts by UTC day. Concurrent sweep executions can still duplicate an operator alert.
- There is deliberately no automatic customer follow-up lane. Add one only with durable suppression for rejection, expiry, reply, payment, cancellation, and provider acknowledgement.
- Raw webhook bodies and tokens can appear in n8n execution history even though only bounded whitelisted fields reach the Data Table. Configure retention, pruning, and access controls appropriately.
- One token authorizes its entire webhook lane. Add tenant-specific authentication and authorization when mutually untrusted tenants share the workflow.
- The template does not claim exactly-once email, legal acceptance, signature, CRM synchronization, automatic recovery, or end-to-end sales fulfilment.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json`.
- [ ] Verify the upload hash is `c80dcb22b3b98610a64643b1aa3e2e519c58c00c9ecf045b37afb6393517b436`.
- [ ] Confirm the canvas shows one yellow overview and ten white narrative sections.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select Gmail, n8n Data Tables, and Webhook as integrations if the portal asks for them.
- [ ] Use `Sales` and `Finance` as the categories.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
