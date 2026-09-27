# n8n-sme-workflows

[n8n](https://n8n.io) workflow templates for SME back-office automation, engineered well past demo grade: lead intake, invoicing and dunning, document intake, support triage, ops reporting, bank reconciliation, Polish KSeF e-invoicing, client onboarding, replay-safe kickoff booking, order tracking, controlled fixed-price quoting, branded client report drafts, complaint ownership with response deadlines, and CRM ↔ invoicing field reconciliation.

Agent cold start: read [`AGENTS.md`](AGENTS.md), select its one primary task route, and follow that route's ordered local sources and gates.

Each workflow is an import-ready JSON built to a consistent engineering standard, with a README documenting the business problem, the design decisions, and safe-test instructions.

## Workflows

All 14 workflows are also published as free templates on the n8n template library under the [Kuliberda Labs creator page](https://n8n.io/creators/klabs/). The `workflow.json` in this repository is the canonical behavior source; each workflow folder also carries the annotated `workflow-annotated-v2.json` prepared for the template library.

| # | Workflow | What it automates | n8n template |
|---|----------|-------------------|--------------|
| [01](workflows/01-lead-intake/) | SME Lead Intake | Webhook lead capture → validation → routing (approved / needs-review / sensitive) → email alerts | [17741](https://n8n.io/workflows/17741/) |
| [02](workflows/02-invoice-dunning/) | Invoice Dunning | Invoice-on-completion, idempotent payment reminders, pre-send stop-on-paid checks | [18054](https://n8n.io/workflows/18054/) |
| [03](workflows/03-document-intake/) | Document Intake with AI Classification | Inbound documents → OCR/AI classification with validation gates → filing or human review | [18351](https://n8n.io/workflows/18351/) |
| [04](workflows/04-support-triage/) | Support Triage + FAQ Draft | Ticket triage with layered prompt-injection defenses; replies are drafts by design — the intake graph has no path to a send node | [17988](https://n8n.io/workflows/17988/) |
| [05](workflows/05-ops-digest-alert/) | Scheduled Ops Digest + Anomaly Alert | Daily digest with anomaly alerting and alert throttling | [18148](https://n8n.io/workflows/18148/) |
| [06](workflows/06-bank-reconciliation/) | Bank ↔ Invoice Reconciliation | Deterministic (AI-free) matching of bank payments to invoices, review queue for ambiguity | [18420](https://n8n.io/workflows/18420/) |
| [07](workflows/07-ksef-exception-desk/) | KSeF Exception Desk | Exception handling for Poland's mandatory e-invoicing system: query-before-retry, durable state | [18704](https://n8n.io/workflows/18704/) |
| [08](workflows/08-client-onboarding-saga/) | Client Onboarding Saga | Saga-pattern orchestration of multi-step onboarding with durable state and duplicate-send protection | [18626](https://n8n.io/workflows/18626/) |
| [09](workflows/09-booking-lifecycle/) | Booking Lifecycle | Replay-safe client kickoff booking with durable intent, Google Calendar provider evidence, and Gmail drafts | [18741](https://n8n.io/workflows/18741/) |
| [10](workflows/10-order-status-tracker/) | Order Status Tracker | Token-separated order intake and status transitions with durable history, notification dedup, stale-pending visibility, and safe customer lookup | [18823](https://n8n.io/workflows/18823/) |
| [11](workflows/11-quote-offer/) | Quote and Offer Workflow | Authenticated fixed-price quoting with durable replay and conflict guards, approval decisions, provider-evidence delivery, and stale-state alerts | [18873](https://n8n.io/workflows/18873/) |
| [12](workflows/12-client-report-engine/) | Branded Client Report Draft Engine | Authenticated multi-client report validation → deterministic branded HTML → replay-suppressed Gmail drafts with privacy-minimal lifecycle evidence | [19006](https://n8n.io/workflows/19006/) |
| [13](workflows/13-complaint-sla-intake/) | Complaint Intake and Owned SLA | Metadata-only complaint intake, role-bound ownership, explicit response deadlines, and durable internal Gmail alerts | [19315](https://n8n.io/workflows/19315/) |
| [14](workflows/14-crm-invoicing-reconciliation/) | CRM and Invoicing Reconciliation | Owner-defined field synchronization through conditional REST adapter writes, independent readback and a minimal durable journal | [19412](https://n8n.io/workflows/19412/) |

## Engineering approach

These are templates, not a hosted product. Each one demonstrates patterns that most workflow templates skip:

- **Idempotency keys** — stable content-derived keys plus replay guards, so repeated deliveries don't double side effects (best-effort claims, not atomic locks — the READMEs say which is which).
- **Explicit failure paths** — dead-letter routes and fail-closed 401s instead of silent drops.
- **Human-in-the-loop where it matters** — AI outputs are validated and gated; ambiguous cases go to review, not to customers.
- **Outbound safety** — outbound email to a real person is draft-first or approval-gated in the default configuration, with one documented exception: workflow 11 auto-sends only eligible standard quotes, under explicit limits, to a verified submitted address.
- **Honest limits** — each workflow README states what the workflow does *not* do and records its current hardening needs; completed remediation remains traceable in closed GitHub Issues. Treat the templates as a strong starting point you adapt and harden for your environment, not a drop-in production system.

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
