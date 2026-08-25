# n8n Creators submission — Bank Reconciliation

## Upload

`workflow-annotated-v2.json`

SHA-256: `30beeb2c785b62a4017c166982b618ae09a043ea82b9a24c49a6b1cc13b45a9e`

## Title

Reconcile bank payments to invoices with deterministic matching and n8n Data Tables

## Short description

Match parsed bank payments to open invoices with deterministic rules, persist auditable results in n8n Data Tables, and hold ambiguous, partial, or overpaid cases for human review.

## Categories

1. Invoice Processing

## Description

# Reconcile bank payments to invoices without guessing

This workflow helps small finance and operations teams handle the recurring task of matching incoming bank payments to open invoices. It accepts already-parsed statement rows through an authenticated webhook and also includes a safe manual fixture for testing the complete reconciliation path.

Matching is deterministic and AI-free. The workflow can use an invoice number in the transfer title, one exact invoice amount, or one exact multi-invoice total. Ambiguous matches, unknown payers, malformed rows, partial payments, and overpayments are never forced into a result. They are stored in a review queue with the reason and candidate invoices for a human to decide.

Each run writes six durable row sets to n8n Data Tables: bank transactions, invoices, allocations, review cases, paid signals, and a run summary. The workflow reads those rows back and verifies their counts and keys before it commits replay markers, sends the internal Gmail summary, or returns webhook success. Confirmed payments create paid-signal rows that another reminder workflow can consume; this workflow does not contact customers or stop reminders itself.

## How it works

1. Receives parsed bank rows and open invoices through a token-protected webhook, or starts with the built-in manual fixture.
2. Loads prior transaction and review rows to recognize replayed imports.
3. Normalizes payment references, payer aliases, invoice data, and amount tolerance.
4. Applies deterministic invoice-number, exact-amount, and exact multi-invoice matching rules.
5. Holds ambiguous, partial, overpaid, unknown-payer, and malformed cases for review.
6. Writes transactions, invoices, allocations, review cases, paid signals, and the run summary to six Data Tables.
7. Reads all six row sets back, verifies persistence, commits replay markers, and only then sends the internal summary and webhook response.

## Setup

1. Create six n8n Data Tables named `Recon_Bank_Transactions`, `Recon_Invoices`, `Recon_Allocations`, `Recon_Review_Queue`, `Recon_Paid_Signals`, and `Recon_Run_Summaries`. Add the columns mapped by the corresponding Insert nodes, then re-select your table in every Insert, preload Get, and Read Back node.
2. Create the `BANK_IMPORT_TOKEN` n8n Variable. Callers must send the same value in `x-bank-import-token` or a Bearer authorization header.
3. Connect a Gmail credential to both summary-email nodes.
4. Replace every `ops@example.com` value with a controlled internal finance or operations inbox.
5. Keep the workflow inactive while testing. Run `Runtime Simulator Sweep` first, then post a small parsed statement payload to the test webhook and inspect all six Data Tables.
6. Test an exact invoice reference, one exact amount, one multi-invoice total, an ambiguous match, a partial payment, an overpayment, and a replayed import before activation.

## Good to know

- The webhook expects parsed JSON rows. It does not connect to a bank, read a CSV, or extract data from a PDF statement.
- The matching engine is deterministic and does not call an AI model.
- Partial payments and overpayments are not auto-closed; they remain review cases until the business defines a policy.
- Paid signals are durable output for another workflow. This template does not contact customers or stop reminders directly.
- n8n Variables require a plan that supports `$vars`. If unavailable, replace the token source with another server-side secret mechanism.
- The six Data Table writes are verified but are not one database transaction. A mid-run failure can leave partial rows that an operator should inspect before replaying.
- Replay protection uses hashed keys, workflow static data, and table lookups rather than an atomic lock, so truly concurrent imports of the same statement can still race.
- The persistence barrier depends on n8n v1 execution order and the summary branch remaining last.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json` and not the QA fresh export.
- [ ] Verify the upload hash is `30beeb2c785b62a4017c166982b618ae09a043ea82b9a24c49a6b1cc13b45a9e`.
- [ ] Confirm the canvas shows one yellow overview and 11 balanced white section backgrounds with 3–7 functional nodes per section.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select Gmail and Data Tables as integrations if the portal asks for them.
- [ ] Use `Invoice Processing` as the category.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
