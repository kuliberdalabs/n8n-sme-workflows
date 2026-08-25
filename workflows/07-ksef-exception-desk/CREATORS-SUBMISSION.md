# n8n Creators submission — KSeF Exception Desk

## Upload

`workflow-annotated-v2.json`

SHA-256: `99bebf814e4f957f77842b92baaf759f917a0fffadcedfa7464349045f52c909`

## Title

Handle KSeF invoice exceptions without blind retries using Data Tables

## Short description

Persist KSeF invoice intake, simulate submission outcomes, query status before retrying, and route unresolved cases through Data Tables and Gmail.

## Categories

1. Invoice Processing

## Description

# Handle KSeF invoice exceptions without blind resubmission

This workflow helps finance and operations teams model a safer KSeF invoice-submission process around ambiguous responses, crashes after intent, rate limits, and incomplete UPO capture. A token-protected webhook validates an explicit invoice payload, stores its exact JSON snapshot and SHA-256 hash in n8n Data Tables, and cannot reach the submit adapter.

A single manual trigger routes each execution to intake fixtures, submission, or recovery. The submission path rereads lifecycle state, verifies the stored snapshot and legal identity, checks required fields and XML shape, NIP checksums, a caller-provided mock whitelist status, approval records, and the selected auth-adapter mode. It writes durable submit intent before invoking the bundled mock adapter.

Recovery runs manually or every 30 minutes and queries the mock status adapter before any retry. `ACCEPTED` results are adopted with their reference and UPO; only authoritative `NOT_FOUND` permits one retry. `UNKNOWN`, `ERROR`, and non-authoritative results remain held with no submit call. Lifecycle, evidence, exception, and run-summary rows are persisted, while Gmail sends controlled intake summaries and aged-recovery alerts to an internal operations inbox.

This template does not call the real KSeF API. Replacing the submit, status, VAT-whitelist, and authentication adapters—and validating them against production requirements—is required before real use.

## How it works

1. Receives explicit invoice data through a token-protected webhook or a built-in synthetic intake fixture.
2. Validates required fields, XML shape, NIP checksums, whitelist status, and approval records.
3. Stores the exact intake snapshot and SHA-256 hash without submitting from the intake path.
4. Routes one manual execution to submission, recovery, or fixture intake.
5. Rereads lifecycle state and writes submit intent before running the local mock submit adapter.
6. Records confirmed, rejected, ambiguous, approval, authentication, and rate-limit outcomes in four Data Tables.
7. Queries status before recovery, adopts accepted references, retries only after authoritative `NOT_FOUND`, and alerts on aged unresolved work.

## Setup

1. Create `KSeF_Lifecycle`, `KSeF_Evidence_Log`, `KSeF_Exception_Queue`, and `KSeF_Run_Summaries`, add the fields mapped by their Insert nodes, and re-select your table IDs in every Data Table node.
2. Create the `KSEF_INTAKE_TOKEN` n8n Variable.
3. Optionally create `KSEF_MANUAL_SWEEP_MODE` with `submission`, `recovery`, or `intake_fixture`. Missing or unrecognized values default to `submission`.
4. Connect Gmail credentials to both send nodes and replace `ops@example.com` with a controlled internal inbox.
5. Keep the workflow inactive while testing. Verify that a missing or incorrect intake token returns `401`, then submit explicit valid and invalid invoice payloads and inspect the four tables.
6. Set one manual mode at a time and run `KSeF Manual Sweep` to exercise fixture intake, submission, and recovery.
7. Before real use, replace the synthetic fixture source and all mock KSeF, status, whitelist, and authentication adapters with reviewed production integrations.

## Good to know

- The workflow ships with local mock submit and status adapters. References and UPOs produced by the fixtures are synthetic.
- `whitelist_status` is supplied by the payload or fixture; the workflow does not query the government VAT whitelist API.
- Approval records are checked, including a second approver at or above the configured `10,000` gross threshold. The workflow does not collect approvals.
- The invoice identity guard uses `seller_nip + invoice_number`, but its Data Table read-backs and workflow static data are not an atomic lock.
- The manual selector prevents fan-out inside one execution. Separate manual runs or a scheduled recovery can still overlap, so run one sweep at a time.
- n8n Variables require a plan supporting `$vars`; otherwise replace them with another server-side secret mechanism.
- Gmail is used for controlled internal notifications, not customer delivery.
- The certificate-mode seam fails closed until a real certificate adapter and credential handling are implemented.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json` and not the QA fresh export.
- [ ] Verify the upload hash is `99bebf814e4f957f77842b92baaf759f917a0fffadcedfa7464349045f52c909`.
- [ ] Confirm the canvas shows 59 nodes: 49 functional nodes, one yellow overview, and nine white section backgrounds.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select Gmail and Data Tables as integrations if the portal asks for them.
- [ ] Use `Invoice Processing` as the category.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
- [ ] Do not accept an AI-mutated workflow payload without repeating the exact-payload audit.
