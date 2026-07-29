# n8n-sme-workflows

[n8n](https://n8n.io) workflow templates for SME back-office automation, engineered well past demo grade: lead intake, invoicing and dunning, document intake, support triage, ops reporting, bank reconciliation, Polish KSeF e-invoicing, and client onboarding.

Each workflow is an import-ready JSON built to a consistent engineering standard, with a README documenting the business problem, the design decisions, and safe-test instructions.

## Workflows

| # | Workflow | What it automates |
|---|----------|-------------------|
| [01](workflows/01-lead-intake/) | SME Lead Intake | Webhook lead capture → validation → routing (approved / needs-review / sensitive) → email alerts |
| [02](workflows/02-invoice-dunning/) | Invoice Dunning | Invoice-on-completion, idempotent payment reminders, pre-send stop-on-paid checks |
| [03](workflows/03-document-intake/) | Document Intake with AI Classification | Inbound documents → OCR/AI classification with validation gates → filing or human review |
| [04](workflows/04-support-triage/) | Support Triage + FAQ Draft | Ticket triage with layered prompt-injection defenses; replies are drafts by design — the intake graph has no path to a send node |
| [05](workflows/05-ops-digest-alert/) | Scheduled Ops Digest + Anomaly Alert | Daily digest with anomaly alerting and alert throttling |
| [06](workflows/06-bank-reconciliation/) | Bank ↔ Invoice Reconciliation | Deterministic (AI-free) matching of bank payments to invoices, review queue for ambiguity |
| [07](workflows/07-ksef-exception-desk/) | KSeF Exception Desk | Exception handling for Poland's mandatory e-invoicing system: query-before-retry, durable state |
| [08](workflows/08-client-onboarding-saga/) | Client Onboarding Saga | Saga-pattern orchestration of multi-step onboarding with durable state and duplicate-send protection |

## Engineering approach

These are templates, not a hosted product. Each one demonstrates patterns that most workflow templates skip:

- **Idempotency keys** — stable content-derived keys plus replay guards, so repeated deliveries don't double side effects (best-effort claims, not atomic locks — the READMEs say which is which).
- **Explicit failure paths** — dead-letter routes and fail-closed 401s instead of silent drops.
- **Human-in-the-loop where it matters** — AI outputs are validated and gated; ambiguous cases go to review, not to customers.
- **Outbound safety** — anything that emails a real person is draft-first or approval-gated in its default configuration.
- **Honest limits** — each README states what the workflow does *not* do, and known hardening gaps (delivery-retry sweeps, atomic claims, stricter contracts) are tracked openly as GitHub Issues. Treat the templates as a strong starting point you adapt and harden for your environment, not a drop-in production system.

## Getting started

1. In n8n: **Workflows → Import from File** and select a `workflow.json`.
2. Replace the `ops@example.com` placeholder addresses with your own.
3. Attach your own credentials (e.g. Gmail OAuth) to the email nodes — the templates ship without any credentials.
4. Follow the workflow's README to run a safe test before activating anything.

Tested on current n8n; the workflows use standard nodes (webhook, code, IF/switch, Gmail) — no community-node dependencies.

## About

Built and maintained by [Kuliberda Labs](https://kuliberda.ai) — process automation for small and medium businesses.

This repository contains only original workflow definitions and documentation. It includes no proprietary software and no credentials. Users are responsible for complying with the terms of service of any third-party systems they connect these workflows to.

## License

[MIT](LICENSE)
