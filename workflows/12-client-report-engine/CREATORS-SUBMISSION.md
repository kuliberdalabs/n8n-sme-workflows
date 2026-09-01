# n8n Creators submission — Branded Client Report Draft Engine

## Upload

`workflow-annotated-v2.json`

SHA-256: `a60a26921195db72fcc95ee67b5ecfa7a40066d5b74630add9043cd4e6638aa9`

## Title

Create replay-safe branded client report drafts with Gmail and n8n Data Tables

## Short description

Validate a multi-client report batch, render deterministic tenant-branded HTML, and create replay-suppressed Gmail drafts without sending them.

## Categories

1. Productivity
2. Sales

## Integrations

1. Gmail
2. n8n Data Tables
3. Webhook

## Description

# Create controlled branded report drafts from validated webhook data

This inactive workflow accepts one authenticated batch of one to 20 client reports. The webhook data is supplied by your own upstream system; the workflow validates it but does not fetch CRM, analytics, finance, or other sources.

Each client is isolated. Invalid input is returned as a bounded per-report error while valid siblings continue; oversized or otherwise invalid scalar values are not reflected. Exact scalar types, key sets, lengths, locale, six-digit brand color, equal verified recipient, explicit-offset source timestamp, strict narrative arrays, nonnegative integer metrics, and funnel ordering are all checked before Data Table or Gmail work.

For `complete` reports, the workflow renders tenant-branded deterministic HTML with performance, highlights, risks, next steps, and source metadata. `complete_no_data` requires an empty metrics object and renders an explicit no-data statement instead of misleading zeros. All caller text is HTML-escaped. The workflow uses no AI.

SHA-256 scope, recipient, content, and fingerprint identities control replay. The workflow reads every physical Data Table row in the exact tenant-period-template scope. A confirmed identical draft becomes a terminal replay, changed content becomes an identity conflict, partial state requires reconciliation, and two or more rows fail closed. It never takes the first row as truth.

A new report persists privacy-minimal `Draft Intent` metadata and requires exactly one matching acknowledgement before Gmail. Gmail creates a draft to the validated recipient; it never sends. A provider draft id is required for `Draft Ready`. Missing provider evidence becomes `Draft Pending Reconcile`, and the exact lifecycle update must also be acknowledged.

The single JSON webhook response summarizes every report without returning recipient addresses or report HTML.

## Setup

1. Create one n8n Data Table named `Client_Report_Ledger` with the exact string and date columns documented in the workflow README.
2. Re-select that table in all three Data Table nodes to replace `REPLACE_WITH_CLIENT_REPORT_LEDGER_TABLE_ID`.
3. Create the server-side n8n Variable `CLIENT_REPORT_INTAKE_TOKEN` with at least 16 characters.
4. Attach Gmail OAuth to `Create Gmail Report Draft`.
5. Keep the workflow inactive while testing with synthetic `.example.test` recipients.
6. Configure n8n execution retention and access controls for webhook privacy.

## Good to know

- Webhook data is supplied and validated; no source system is fetched.
- Gmail drafts are created but never sent.
- The template renders HTML email and does not generate a PDF.
- n8n Data Tables provide sequential replay suppression, not an atomic unique constraint, lock, or transaction. Concurrent first deliveries can race.
- Gmail creation and Data Table acknowledgement are separate. Partial state is held for reconciliation and is never blindly redrafted.
- The ledger excludes recipient addresses, report HTML, client name, brand fields, highlights, risks, and next steps.
- Raw webhook bodies and authorization data may remain in n8n execution history. Configure retention, pruning, encryption, and access controls.
- The workflow claims no AI generation, forecasting, anomaly detection, exactly-once delivery, automatic sending, or automatic reconciliation.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json`.
- [ ] Verify the upload hash matches the SHA-256 above.
- [ ] Confirm one yellow overview and four balanced white narrative sections.
- [ ] Confirm every section uses 192 px top padding and every functional node is covered exactly once.
- [ ] Keep the workflow inactive and attach no credentials to the uploaded file.
- [ ] Select Gmail, n8n Data Tables, and Webhook as integrations.
- [ ] Select Productivity and Sales as categories.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
