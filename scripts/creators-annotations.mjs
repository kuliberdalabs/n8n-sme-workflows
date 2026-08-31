#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICKY_TYPE = 'n8n-nodes-base.stickyNote';
const NODE_SIZE = 96;
const DEFAULT_OVERVIEW_SIZE = { width: 896, height: 896 };
const DEFAULT_SECTION_BOTTOM_PADDING = 128;
const DEFAULT_SECTION_TOP_PADDING = 192;
// Existing artifact compatibility only. Never copy this override into a new
// or reviewer-corrected submission.
const LEGACY_SECTION_TOP_PADDING = 144;
const MIN_SECTION_WIDTH = 512;

const WORKFLOWS = {
  '02-invoice-dunning': {
    enforceEdgeCorridors: true,
    acceptedLegacyLayout: true,
    acceptedArtifactSha256: 'd3d2d6df1ae3eb28ad48d7a8b28013af7dc1e7800339a10ab9b75a566b40e754',
    sectionTopPadding: LEGACY_SECTION_TOP_PADDING,
    overviewSize: DEFAULT_OVERVIEW_SIZE,
    sectionBottomPadding: DEFAULT_SECTION_BOTTOM_PADDING,
    overviewTitle: 'Send invoices and chase overdue payments',
    overview: `## Send invoices and chase overdue payments

### How it works
1. Receives job-completion events, validates the token, and stores malformed inputs as dead letters.
2. Prices completed work from a fixed price book, creates a deterministic invoice key, and persists the invoice before sending email.
3. Receives payment events, deduplicates them, and marks matched invoices paid before later reminder updates can overwrite them.
4. Runs daily reminder and escalation sweeps with a fresh status recheck immediately before each controlled email.
5. Queues unmatched payments for human review and stops after the configured reminder or escalation threshold.

### Setup steps
- [ ] Create the required n8n Data Tables and re-select them in every Data Table node.
- [ ] Connect Gmail OAuth and replace \`ops@example.com\` in every Gmail node.
- [ ] Set \`DUNNING_WEBHOOK_TOKEN\` and send it in the documented request header.
- [ ] Configure the price book, VAT, currency, reminder timing, and escalation thresholds.
- [ ] Test completion, duplicate, invalid, payment, and sweep paths while the workflow is inactive.

### Customization
Adjust service prices, payment matching, reminder cadence, escalation rules, and the controlled operator inbox to match your invoicing process.`,
    sections: [
      section('Receive completion event', 'Validates the completion webhook, normalizes the job, handles ignored events, and claims the side effect.', 0, 0, 8, [
        'Job Completion Webhook', 'Validate Completion Token', 'Completion Authorized?', 'Respond Completion Unauthorized',
        'Normalize Completion Event', 'Completion Event Ignored?', 'Respond Completion Ignored', 'Claim Completion Side Effect',
      ], { 'Respond Completion Unauthorized': [3, 1], 'Normalize Completion Event': [3, 0], 'Respond Completion Ignored': [6, 1], 'Claim Completion Side Effect': [6, 0] }),
      section('Deduplicate completion', 'Reuses an existing invoice result and prevents replayed completion events from creating another invoice.', 2368, 0, 5, [
        'Completion Claim Duplicate?', 'Find Claimed Completion Row', 'Find Existing Invoice Row', 'Persistent Invoice Duplicate?', 'Respond Invoice Duplicate',
      ], { 'Find Existing Invoice Row': [1, 1], 'Persistent Invoice Duplicate?': [2, 1], 'Respond Invoice Duplicate': [3, 0] }),
      section('Persist invoice outcome', 'Stores invalid jobs as dead letters or persists, emails, and confirms a newly created invoice.', 3968, 0, 7, [
        'Completion Invalid?', 'Insert Completion Dead Letter', 'Mark Completion Claim Dead Letter', 'Respond Completion Dead Letter',
        'Insert Invoice Pending Email', 'Send Controlled Invoice Email', 'Build Invoice Email Update', 'Update Invoice Email Sent',
        'Mark Invoice Claim Sent', 'Respond Invoice Sent',
      ], {
        'Insert Invoice Pending Email': [1, 1], 'Send Controlled Invoice Email': [2, 1],
        'Build Invoice Email Update': [3, 1], 'Update Invoice Email Sent': [4, 1],
        'Mark Invoice Claim Sent': [5, 1], 'Respond Invoice Sent': [6, 1],
      }),
      section('Receive payment event', 'Authenticates and validates payment callbacks before claiming a valid event for processing.', 0, 640, 8, [
        'Payment Webhook', 'Validate Payment Token', 'Payment Authorized?', 'Respond Payment Unauthorized',
        'Normalize Payment Event', 'Payment Invalid?', 'Respond Payment Dead Letter', 'Claim Payment Event',
      ], { 'Respond Payment Unauthorized': [3, 1], 'Normalize Payment Event': [3, 0], 'Respond Payment Dead Letter': [6, 1], 'Claim Payment Event': [6, 0] }),
      section('Match payment safely', 'Resolves duplicate and new-event invoice scope deterministically, then hands matched or unmatched outcomes forward without guessing.', 2368, 640, 8, [
        'Payment Claim Duplicate?', 'Find Duplicate Payment Invoice Row', 'Resolve Duplicate Payment Invoice Scope',
        'Duplicate Payment Invoice Missing?', 'Find New Payment Invoice Row', 'Resolve New Payment Invoice Scope',
        'New Payment Invoice Missing?', 'Find Unmatched Payment Queue Row',
      ], {
        'Payment Claim Duplicate?': [0, 5], 'Find Duplicate Payment Invoice Row': [1, 0],
        'Resolve Duplicate Payment Invoice Scope': [3, 0], 'Duplicate Payment Invoice Missing?': [5, 0],
        'Find New Payment Invoice Row': [1, 10], 'Resolve New Payment Invoice Scope': [3, 10],
        'New Payment Invoice Missing?': [5, 10], 'Find Unmatched Payment Queue Row': [7, 5],
      }),
      section('Persist payment outcome', 'Deduplicates unmatched review rows, handles already-paid events, or atomically marks the matched invoice paid before responding.', 4672, 640, 15, [
        'Unmatched Payment Already Queued?', 'Respond Payment Unmatched', 'Build Unmatched Payment Queue Row',
        'Insert Unmatched Payment Queue Row', 'Payment Already Paid?', 'Respond Payment Duplicate',
        'Build Paid Update', 'Update Invoice Paid', 'Mark Payment Claim Paid', 'Respond Payment Marked Paid',
      ], {
        'Unmatched Payment Already Queued?': [0, 5], 'Respond Payment Unmatched': [3, 3],
        'Build Unmatched Payment Queue Row': [3, 7], 'Insert Unmatched Payment Queue Row': [6, 5],
        'Payment Already Paid?': [11, 5], 'Respond Payment Duplicate': [11, 2],
        'Build Paid Update': [11, 8], 'Update Invoice Paid': [12, 8],
        'Mark Payment Claim Paid': [13, 8], 'Respond Payment Marked Paid': [14, 8],
      }),
      section('Claim due reminders', 'Selects due invoices, claims each reminder, and rechecks current status before any email.', 0, 3712, 6, [
        'Daily Dunning Sweep', 'Find Invoice Sent Rows', 'Build Due Dunning Actions', 'Claim Dunning Action',
        'Find Dunning Recheck Row', 'Build Dunning Recheck Decision',
      ]),
      section('Send controlled reminder', 'Persists the pending claim, sends to the controlled inbox, and records confirmed delivery state.', 1856, 3712, 6, [
        'Build Dunning Pending Update', 'Update Dunning Pending Claim', 'Send Controlled Dunning Nudge',
        'Build Dunning Sent Update', 'Update Dunning Sent', 'Mark Dunning Claim Sent',
      ]),
      section('Claim due escalations', 'Selects stuck invoices, claims each escalation, and rechecks eligibility before alerting a human.', 3712, 3712, 6, [
        'Daily Dunning Escalation Sweep', 'Find Escalation Invoice Rows', 'Build Due Escalation Actions',
        'Claim Escalation Action', 'Find Escalation Recheck Row', 'Build Escalation Recheck Decision',
      ]),
      section('Escalate to operator', 'Persists the escalation claim, alerts the controlled inbox, and records the final escalated state.', 5568, 3712, 6, [
        'Build Escalation Pending Update', 'Update Escalation Pending', 'Send Controlled Escalation Alert',
        'Build Escalation Sent Update', 'Update Escalation Sent', 'Mark Dunning Claim Escalated',
      ]),
    ],
  },
  '03-document-intake': {
    enforceEdgeCorridors: true,
    overviewTitle: 'Classify inbound documents and route uncertain cases',
    overview: `## Classify inbound documents and route uncertain cases

### How it works
1. Receives an authenticated document payload with identity, MIME type, and OCR text, then derives a deterministic key and exact owner/run scope.
2. Uses a best-effort in-memory claim plus durable Data Table history to recognize replays without reprocessing the document.
3. Stores permanent contract or MIME failures as dead letters and routes unreadable or low-quality OCR to human review before any model call.
4. Sends only a redacted, bounded excerpt to OpenAI, then validates the returned schema, duplicate keys, enums, values, and confidence thresholds.
5. Records fully validated results under a safe logical archive path; everything else becomes Needs Review with a controlled operator alert.
6. Runs an hourly sweep that retries review alerts whose provider evidence was never persisted.

### Setup steps
- [ ] Create and re-select the Intake_Documents Data Table in every table node.
- [ ] Set DOC_INTAKE_WEBHOOK_TOKEN and send it in the documented header.
- [ ] Connect OpenAI and Gmail credentials, then replace ops@example.com.
- [ ] Review the supported MIME, OCR, taxonomy, and confidence rules.
- [ ] Test invalid, duplicate, low-OCR, filed, AI-review, and alert-retry paths while inactive.

### Customization
Adapt the intake adapter, classification taxonomy, confidence policy, logical storage path, and controlled review inbox to your document process.`,
    sections: [
      section('Authenticate and claim intake', 'Fails closed on authentication, normalizes the document contract, and places a best-effort claim before durable lookup.', 0, 0, 6, [
        'Document Intake Webhook', 'Validate Intake Token', 'Intake Authorized?', 'Respond Intake Unauthorized',
        'Normalize Document Intake', 'Claim Document Key',
      ], { 'Respond Intake Unauthorized': [3, 1], 'Normalize Document Intake': [3, 0], 'Claim Document Key': [4, 0] }),
      section('Resolve duplicate deliveries', 'Checks active claims and durable history, then returns an existing result without reprocessing.', 1856, 0, 5, [
        'Document Claim Duplicate?', 'Find Claimed Document Row', 'Find Existing Document Row',
        'Persistent Document Duplicate?', 'Respond Document Duplicate',
      ], { 'Find Claimed Document Row': [1, 0], 'Find Existing Document Row': [1, 1], 'Persistent Document Duplicate?': [2, 1], 'Respond Document Duplicate': [3, 0] }),
      section('Reject invalid input or OCR', 'Persists permanent dead letters and keeps unusable OCR on a human-review path before model extraction.', 3456, 0, 5, [
        'Document Intake Dead Letter?', 'Insert Document Dead Letter', 'Mark Document Claim Dead Letter',
        'Respond Document Dead Letter', 'OCR Usable?',
      ], { 'OCR Usable?': [1, 1] }),
      section('Extract and file confidently', 'Constrains AI extraction with strict schema validation and records only high-confidence results as logically filed.', 5056, 0, 6, [
        'Extract Document Fields', 'Validate AI Extraction', 'AI Validated Auto File?',
        'Insert Filed Document Record', 'Mark Document Claim Filed', 'Respond Document Filed',
      ]),
      section('Alert on AI review', 'Persists non-auto-file outcomes before alerting the operator and records the provider evidence.', 6912, 640, 6, [
        'Insert AI Needs Review', 'Send Controlled AI Review Alert', 'Build AI Review Alert Update',
        'Update AI Review Alert Sent', 'Mark Document Claim AI Review', 'Respond AI Needs Review',
      ]),
      section('Alert on OCR review', 'Stores unusable-OCR cases without a model call and records the controlled review-alert outcome.', 5056, 640, 6, [
        'Insert OCR Needs Review', 'Send Controlled OCR Review Alert', 'Build OCR Review Alert Update',
        'Update OCR Review Alert Sent', 'Mark Document Claim OCR Review', 'Respond OCR Needs Review',
      ]),
      section('Retry unsent review alerts', 'Finds review rows still marked unsent, retries Gmail, and persists the resulting alert evidence.', 0, 688, 6, [
        'Document Review Alert Reconciliation Sweep', 'Find Unsent Document Review Alerts',
        'Build Unsent Document Review Alert', 'Send Reconciled Document Review Alert',
        'Build Reconciled Document Alert Update', 'Update Reconciled Document Alert Sent',
      ]),
    ],
  },
  '05-ops-digest-alert': {
    enforceEdgeCorridors: true,
    // n8n 2.34.5 rendered a rejected 256 px note through y=144.39. Keep a
    // full 48 px grid step below that boundary for this corrected artifact.
    sectionTopPadding: 192,
    overviewTitle: 'Send a daily operations digest and signal real anomalies',
    overview: `## Send a daily operations digest and signal real anomalies

### How it works
1. Runs each morning and fetches sales, support, calendar, and finance data from four configured HTTP endpoints.
2. Normalizes every source into deterministic counts and oldest-item ages, while failed or incomplete sources make the digest visibly degraded.
3. Aggregates the operational facts before OpenAI drafts only the prose summary; a validator rejects unsafe, empty, or number-bearing model text and uses a fixed fallback.
4. Sends one controlled ambient digest on every run, then evaluates anomalies separately against source-specific age thresholds.
5. Sends a signal alert only for unthrottled anomalies and records its daily throttle key after the Gmail send step succeeds.

### Setup steps
- [ ] Set the four documented \`OPS_*_URL\` variables for your source endpoints.
- [ ] Connect HTTP Header Auth, OpenAI, and Gmail credentials in the matching nodes.
- [ ] Replace \`ops@example.com\` in both Gmail nodes.
- [ ] Tune age and healthy-count thresholds inside each normalization node.
- [ ] Test manually while inactive, first with degraded placeholders and then with a mock old item.

### Customization
Adapt the source contracts, daily schedule, SLA thresholds, summary tone, and controlled inbox without moving numbers or alert decisions into the model.`,
    sections: [
      section('Collect operational sources', 'Fetches and normalizes sales, support, calendar, and finance data with explicit degraded-state handling.', 0, 0, 9, [
        'Morning Digest Schedule', 'Fetch Sales Source', 'Normalize Sales Source', 'Fetch Support Source',
        'Normalize Support Source', 'Fetch Calendar Source', 'Normalize Calendar Source', 'Fetch Finance Source',
        'Normalize Finance Source',
      ]),
      section('Build the ambient digest', 'Aggregates deterministic facts, validates model-written prose, and sends the controlled daily digest.', 2624, 0, 5, [
        'Aggregate Digest Inputs', 'Draft Ambient Summary', 'Validate Digest Summary',
        'Build Ambient Digest Email', 'Send Controlled Ambient Digest',
      ]),
      section('Decide whether to alert', 'Filters daily throttle keys and cleanly separates actionable anomalies from a no-alert run.', 4224, 0, 3, [
        'Throttle Alert Anomalies', 'Signal Alert Needed?', 'No Signal Alert',
      ], { 'No Signal Alert': [2, 1] }),
      section('Send the anomaly signal', 'Builds and sends the controlled alert before recording its throttle key as consumed.', 5312, 0, 3, [
        'Build Signal Alert Email', 'Send Controlled Anomaly Alert', 'Record Sent Alert Throttle',
      ]),
    ],
  },
  '06-bank-reconciliation': {
    enforceEdgeCorridors: true,
    sectionTopPadding: DEFAULT_SECTION_TOP_PADDING,
    overviewSize: { width: 704, height: 704 },
    overviewTitle: 'Reconcile bank payments to invoices',
    overview: `## Reconcile bank payments to invoices

### How it works
1. Accepts parsed statement JSON through an authenticated webhook or runs a built-in manual fixture.
2. Loads prior transaction and review rows, then matches payments by invoice reference, exact amount, or an exact multi-invoice total.
3. Holds ambiguous, malformed, partial, and overpaid cases for review instead of guessing.
4. Writes six Data Table record sets and verifies every execution-scoped write before committing replay markers, sending the operator summary, or returning success.

### Setup steps
- [ ] Create and re-select all six documented Recon Data Tables.
- [ ] Set BANK_IMPORT_TOKEN for the webhook.
- [ ] Connect Gmail and replace ops@example.com in both summary nodes.
- [ ] Keep executionOrder v1 and the summary branch last.
- [ ] Test the manual fixture and a small tagged webhook import while inactive.

### Customization
Adapt the parsed input, payer aliases, amount tolerance, review rules, paid-signal consumer, and operator inbox.`,
    sections: [
      section('Receive and authorize webhook', 'Authenticates the import, shapes valid input, and returns unauthorized requests without side effects.', 0, 0, 4, [
        'Import Webhook', 'Validate Import Token', 'Import Authorized?', 'Build Webhook Statement Contract',
        'Build Unauthorized Response', 'Respond Unauthorized',
      ], { 'Build Unauthorized Response': [2, 1], 'Respond Unauthorized': [3, 1] }),
      section('Load history and reconcile', 'Loads durable transaction and review history before classifying every webhook payment deterministically.', 1344, 0, 5, [
        'Get Webhook Existing Transactions', 'Merge Webhook Existing Transactions', 'Get Webhook Existing Reviews',
        'Merge Webhook Existing Reviews', 'Run Webhook Reconciliation Engine',
      ]),
      section('Write core webhook records', 'Persists normalized transactions, invoices, and safe allocations in execution order.', 2944, 0, 2, [
        'Emit Webhook Transaction Rows', 'Insert Webhook Transaction Rows',
        'Emit Webhook Invoice Rows', 'Insert Webhook Invoice Rows',
        'Emit Webhook Allocation Rows', 'Insert Webhook Allocation Rows',
      ]),
      section('Write review and finish records', 'Persists review cases, paid signals, and the summary row that starts the final barrier.', 2944, 976, 2, [
        'Emit Webhook Review Rows', 'Insert Webhook Review Rows',
        'Emit Webhook Signal Rows', 'Insert Webhook Paid Signal Rows',
        'Emit Webhook Summary Row', 'Insert Webhook Summary Row',
      ]),
      section('Read back webhook writes', 'Reads all six execution-scoped row sets back before any success or notification is released.', 3776, 1488, 6, [
        'Read Back Webhook Transaction Writes', 'Read Back Webhook Invoice Writes',
        'Read Back Webhook Allocation Writes',
        'Read Back Webhook Review Writes', 'Read Back Webhook Paid Signal Writes',
        'Read Back Webhook Summary Writes',
      ]),
      section('Verify and return webhook result', 'Proves durable output, commits replay markers, notifies the operator, and returns the controlled response.', 5632, 1488, 5, [
        'Verify Webhook Persistence Readback', 'Commit Webhook Seen Markers',
        'Send Controlled Webhook Summary', 'Build Webhook Response', 'Respond Import Complete',
      ]),
      section('Run the manual reconciliation', 'Builds the fixture, loads durable history, and runs the same deterministic matcher.', 0, 2304, 7, [
        'Runtime Simulator Sweep', 'Build Runtime Bank Fixture',
        'Get Runtime Existing Transactions',
        'Merge Runtime Existing Transactions', 'Get Runtime Existing Reviews',
        'Merge Runtime Existing Reviews', 'Run Runtime Reconciliation Engine',
      ]),
      section('Write core runtime records', 'Persists fixture transactions, invoices, and safe allocations in the same durable schema.', 2112, 2304, 2, [
        'Emit Runtime Transaction Rows', 'Insert Runtime Transaction Rows',
        'Emit Runtime Invoice Rows', 'Insert Runtime Invoice Rows',
        'Emit Runtime Allocation Rows', 'Insert Runtime Allocation Rows',
      ]),
      section('Write runtime review and finish', 'Persists fixture review cases, paid signals, and the summary row with the same ordering contract.', 2112, 3280, 2, [
        'Emit Runtime Review Rows', 'Insert Runtime Review Rows',
        'Emit Runtime Signal Rows', 'Insert Runtime Paid Signal Rows',
        'Emit Runtime Summary Row', 'Insert Runtime Summary Row',
      ]),
      section('Read back runtime writes', 'Reads all six fixture row sets back before replay markers or the summary email are released.', 2944, 3792, 6, [
        'Read Back Runtime Transaction Writes', 'Read Back Runtime Invoice Writes',
        'Read Back Runtime Allocation Writes',
        'Read Back Runtime Review Writes', 'Read Back Runtime Paid Signal Writes',
        'Read Back Runtime Summary Writes',
      ]),
      section('Verify and finish manual run', 'Proves durable fixture output, commits replay markers, and sends the controlled operator summary.', 4800, 3792, 3, [
        'Verify Runtime Persistence Readback', 'Commit Runtime Seen Markers',
        'Send Controlled Runtime Summary',
      ]),
    ],
  },
  '08-client-onboarding-saga': {
    enforceEdgeCorridors: true,
    overviewTitle: 'Coordinate client onboarding as a durable saga',
    overview: `## Coordinate client onboarding as a durable saga

### How it works
1. Authenticates and validates one onboarding request, then deterministically claims or joins a parent saga in an exact owner and run scope.
2. Writes only missing intents for offer, invoice, kickoff, signed document, welcome-email record, and internal-checklist record.
3. Reads offer, invoice, booking, and document result tables and classifies every exact-key match instead of trusting the first row returned.
4. Blocks unsafe retries, persists changed step decisions, and rolls the parent into a complete, human-required, blocked, or unresolved state.
5. Runs a fail-stop UTC reconciliation snapshot every 30 minutes to adopt late evidence, repair stale parents, preserve cancellations, and raise age-based alerts.
6. Persists alert intent before Gmail and consumes the throttle receipt only after provider identifiers are validated.

### Setup steps
- [ ] Create and re-select the three onboarding tables and four child-result tables.
- [ ] Set ONBOARDING_INTAKE_TOKEN and review the server-owned tag and child-version variables.
- [ ] Connect Gmail and replace ops@example.com in the reconcile alert node.
- [ ] Ensure Offer and Booking adapters persist exact onboarding_id and smoke_tag fields.
- [ ] Test invalid, first-delivery, replay, late-evidence, conflict, cancellation, and alert paths while inactive.

### Customization
Adapt child adapters, service mappings, wait thresholds, reconciliation cadence, and operator inbox without making the parent resend ambiguous external work.`,
    sections: [
      section('Protect and validate intake', 'Authenticates the webhook, normalizes the contract, and returns explicit unauthorized or invalid responses.', 0, 0, 6, [
        'Client Onboarding Webhook', 'Validate Intake Token', 'Intake Authorized?', 'Normalize Onboarding',
        'Onboarding Valid?', 'Build Unauthorized Response', 'Respond Unauthorized', 'Respond Onboarding Invalid',
      ], { 'Build Unauthorized Response': [3, 1], 'Respond Unauthorized': [4, 1], 'Respond Onboarding Invalid': [5, 1] }),
      section('Claim or join the saga', 'Reads the scoped parent state and inserts a claim only when no matching saga exists.', 1856, 0, 5, [
        'Find Existing Onboarding Rows', 'Build Claim Decision', 'Claim Insert Needed?', 'Emit Claim Row', 'Insert Onboarding Claim Row',
      ], { 'Emit Claim Row': [3, 1], 'Insert Onboarding Claim Row': [4, 1] }),
      section('Write missing step intents', 'Collapses replays and persists only the onboarding step intents that do not already exist.', 3456, 0, 5, [
        'Find Existing Step Rows', 'Build Missing Step Intent Summary', 'Step Intents Needed?',
        'Emit Step Intent Rows', 'Insert Step Intent Rows',
      ], { 'Emit Step Intent Rows': [3, 1], 'Insert Step Intent Rows': [4, 1] }),
      section('Collect child evidence', 'Reads the exact-scope Offer, Invoice, Booking, and Document result tables in sequence.', 5056, 0, 4, [
        'Find Offer Rows', 'Find Invoice Rows', 'Find Booking Rows', 'Find Document Rows',
      ]),
      section('Resolve and persist step state', 'Aggregates child evidence and writes only safe terminal, review, blocked, or unresolved step decisions.', 6400, 0, 4, [
        'Build Parent Saga Decisions', 'Terminal Rows Needed?', 'Emit Step Terminal Rows', 'Update Step Terminal Rows',
      ], { 'Emit Step Terminal Rows': [2, 1], 'Update Step Terminal Rows': [3, 1] }),
      section('Repair parent and respond', 'Recomputes the parent projection, writes only material divergence, and returns the saga receipt.', 7744, 0, 6, [
        'Build Final Write Source', 'Final Onboarding Write Needed?', 'Emit Final Onboarding Row',
        'Update Final Onboarding Row', 'Build Webhook Response', 'Respond Accepted',
      ], { 'Emit Final Onboarding Row': [2, 1], 'Update Final Onboarding Row': [3, 1], 'Build Webhook Response': [4, 0], 'Respond Accepted': [5, 0] }),
      section('Read the reconcile snapshot', 'Fail-stop reads parents, alert receipts, steps, and all four child tables before making decisions.', 0, 832, 9, [
        'UTC Reconcile Sweep', 'Find Reconcile Onboarding Rows', 'Find Existing Reconcile Alert Rows',
        'Find Reconcile Step Rows', 'Find Reconcile Offer Rows', 'Find Reconcile Invoice Rows',
        'Find Reconcile Booking Rows', 'Find Reconcile Document Rows', 'Build UTC Reconcile Alerts',
      ]),
      section('Adopt evidence and repair parents', 'Persists late or corrective step evidence, then rolls up and updates only affected parent scopes.', 2624, 832, 7, [
        'Reconcile Step Adoptions Needed?', 'Emit Reconcile Adopted Step Rows',
        'Update Reconcile Adopted Step Rows', 'Build Reconcile Parent Rollups',
        'Reconcile Parent Updates Needed?', 'Emit Reconcile Parent Rows', 'Update Reconcile Parent Rows',
      ]),
      section('Persist and send reconcile alerts', 'Writes alert intent before Gmail and records a validated provider acknowledgement afterward.', 2624, 1472, 6, [
        'Reconcile Alerts Needed?', 'Emit Reconcile Alert Rows', 'Insert Reconcile Alert Intent Rows',
        'Send Controlled Reconcile Alert', 'Build Alert Sent Update', 'Update Reconcile Alert Sent',
      ]),
    ],
  },
  '09-booking-lifecycle': {
    overviewTitle: 'Create replay-safe client kickoff bookings',
    overview: `## Create replay-safe client kickoff bookings

### How it works
1. Authenticates the booking webhook before validating the exact workflow 08 contract or touching durable and provider state.
2. Validates strict offset timestamps against their IANA timezone, derives stable request evidence, and checks all booking history in the exact onboarding owner and run scope.
3. Returns confirmed replays without new work and sends every changed slot or payload to human review without querying or mutating Google Calendar.
4. Persists booking intent and verifies its acknowledgement before checking native Google Calendar availability, creating a deterministic event, and reading it back.
5. Records confirmation only from matching, non-cancelled provider evidence, then attempts to create a Gmail draft after the confirmed Booking row is durably acknowledged.
6. Reconciles unresolved intents by getting the stored provider event only; missing, duplicate, or mismatched state becomes human review and never another create.

### Setup steps
- [ ] Create the Bookings Data Table with the fields mapped in the Data Table nodes.
- [ ] Set BOOKING_INTAKE_TOKEN and BOOKING_CALENDAR_ID in n8n Variables.
- [ ] Connect Google Calendar and Gmail credentials to their native nodes.
- [ ] Select one local fixture in the manual selector and exercise all seven modes while inactive.
- [ ] Test a tagged webhook request and its exact replay before activation.

### Customization
Adapt the calendar, kickoff copy, reconciliation cadence, and review process while preserving stable parent scope, intent-before-create, provider readback, and draft-only communication.`,
    sections: [
      section('Protect booking intake', 'Authenticates first, validates the exact booking contract, and returns explicit unauthorized or malformed outcomes.', 0, 0, 6, [
        'Booking Intake Webhook', 'Validate Intake Token', 'Intake Authorized?', 'Normalize Booking Request',
        'Booking Request Valid?', 'Build Unauthorized Response', 'Respond Unauthorized', 'Build Invalid Response',
      ], { 'Build Unauthorized Response': [3, 1], 'Respond Unauthorized': [4, 1], 'Build Invalid Response': [5, 1] }),
      section('Resolve durable booking state', 'Reads stable parent-scope history, returns safe replays, and persists changed requests for human review.', 2112, 0, 4, [
        'Find Existing Booking Rows', 'Resolve Booking State', 'Booking Replay?', 'Build Replay Response',
        'Booking Changed?', 'Build Reschedule Review Row', 'Insert Reschedule Review Row', 'Verify Review Acknowledgement',
      ]),
      section('Persist intent and check availability', 'Acknowledges durable create intent before querying availability and records busy outcomes without creating an event.', 3712, 0, 4, [
        'Insert Booking Intent', 'Verify Intent Acknowledgement', 'Check Calendar Availability', 'Slot Available?',
        'Build Busy Update', 'Update Booking Busy', 'Verify Busy Acknowledgement', 'Build Busy Response',
      ]),
      section('Create and confirm provider event', 'Creates only after intent, validates create evidence, reads the event back, and acknowledges the confirmed row before drafting.', 5312, 0, 4, [
        'Create Calendar Event', 'Validate Created Event', 'Get Created Calendar Event', 'Validate Provider Readback',
        'Update Booking Confirmed', 'Verify Booking Confirmation Ack', 'Build Confirmed Response', 'Create Confirmation Draft',
      ]),
      section('Return honest outcomes', 'Builds human-review or confirmed receipts and converges all authenticated responses without overstating draft delivery.', 6912, 0, 3, [
        'Build Human Review Response', 'Finalize Confirmed Response', 'Respond Booking Outcome',
      ]),
      section('Reconcile without recreating', 'Gets only a safely stored provider identity, adopts matching success, and holds every ambiguous result for review.', 0, 1024, 4, [
        'Booking Reconcile Schedule', 'Find Unresolved Booking Intents', 'Build Reconcile Candidates', 'Provider Lookup Safe?',
        'Get Stored Calendar Event', 'Resolve Reconcile Provider State', 'Update Reconciled Booking', 'Verify Reconcile Persistence',
      ]),
      section('Exercise isolated fixtures', 'Selects exactly one synthetic local scenario and terminates in its assertion without reaching state, Calendar, or Gmail.', 0, 2048, 5, [
        'Booking Fixture Manual Trigger', 'Select Fixture Scenario', 'Route Booking Fixture', 'Fixture Available', 'Fixture Busy',
        'Fixture Replay', 'Fixture Invalid Timezone', 'Fixture Failed Before Send',
        'Fixture Provider Success Ack Failure', 'Fixture Changed Slot',
      ]),
    ],
  },
  '10-order-status-tracker': {
    overviewTitle: 'Track orders and serve safe customer status lookups',
    overview: `## Track orders and serve safe customer status lookups

### How it works
1. Uses separate server-side tokens for the create-only order intake lane and the internal status-update lane; request bodies cannot choose their own authority.
2. Requires explicit source event ids, derives deterministic keys, rejects weak lookup secrets, and checks full Status History before evaluation so accepted or held replays do not write again.
3. Creates one order, records accepted or held status evidence, and persists notification intent before Gmail is attempted. A valid re-entry into an already-notified status still updates the Order and History, but does not insert another pending notification or send Gmail again.
4. Accepts exactly one status object per request, rejects batch-shaped payloads, holds strictly older events, and applies an explicit allowed-edge matrix without guessing.
5. Serves a read-only customer lookup that requires tenant, order, and per-order verifier inputs and returns only order id, visible status, update time, and a safe message.
6. Sweeps for notifications left pending for at least two hours and emails a controlled operations inbox.

### Setup steps
- [ ] Create Orders, Status History, and Notifications Data Tables, then re-select them in every table node.
- [ ] Set separate ORDER_INTAKE_TOKEN and ORDER_STATUS_TOKEN n8n Variables.
- [ ] Connect Gmail and replace ops@example.com with your controlled operations inbox.
- [ ] Review the status vocabulary, allowed transitions, notification text, stale threshold, and schedule.
- [ ] Test wrong tokens, weak verifiers, status arrays, replay, older and blocked transitions, lookup, Gmail failure, and stale rows while inactive.

### Customization
Connect your commerce or fulfilment adapters and adjust approved status wording while preserving tenant-scoped keys, separate authority, persist-before-send ordering, safe lookup projection, and explicit residual handling.`,
    sections: [
      section('Protect and classify order intake', 'Authenticates the create-only lane, normalizes required identity and time fields, then resolves the existing order safely.', 0, 0, 5, [
        'Order Intake Webhook', 'Validate Intake Token', 'Intake Token Authorized?', 'Respond Intake Unauthorized',
        'Normalize Order Intake', 'Find Intake Order Row', 'Build Intake Actions',
      ], {
        'Order Intake Webhook': [0, 0], 'Validate Intake Token': [1, 0], 'Intake Token Authorized?': [2, 0],
        'Normalize Order Intake': [3, 0], 'Find Intake Order Row': [4, 0],
        'Respond Intake Unauthorized': [3, 1], 'Build Intake Actions': [4, 1],
      }),
      section('Protect and classify status updates', 'Authenticates one event, joins its Order, and checks full Status History by event key before stale, edge, or hold evaluation.', 0, 768, 5, [
        'Status Update Webhook', 'Validate Status Token', 'Status Token Authorized?',
        'Normalize Status Update', 'Find Status Order Rows', 'Find Status Event History Rows', 'Build Status Actions',
      ], {
        'Status Update Webhook': [0, 0], 'Validate Status Token': [1, 0], 'Status Token Authorized?': [2, 0],
        'Normalize Status Update': [3, 0], 'Find Status Order Rows': [4, 0],
        'Find Status Event History Rows': [3, 1], 'Build Status Actions': [4, 1],
      }),
      section('Deduplicate and route intake outcomes', 'Checks the notification ledger, then separates sendable, held, and no-write replay outcomes.', 1600, 0, 3, [
        'Find Intake Existing Notification Row', 'Apply Intake Notification Dedup',
        'Filter Intake Sendable Notifications', 'Filter Intake Held Actions', 'Filter Intake Terminal No-Write Actions',
      ], {
        'Find Intake Existing Notification Row': [0, 0], 'Apply Intake Notification Dedup': [1, 0],
        'Filter Intake Sendable Notifications': [2, 0], 'Filter Intake Held Actions': [2, 1],
        'Filter Intake Terminal No-Write Actions': [1, 1],
      }),
      section('Deduplicate and route status outcomes', 'Checks every matching milestone row, then separates persistable transitions from held and true no-write outcomes.', 1600, 768, 3, [
        'Find Status Existing Notification Row', 'Apply Status Notification Dedup',
        'Filter Status Persistable Transitions', 'Filter Status Held Actions', 'Filter Status Terminal No-Write Actions',
      ], {
        'Find Status Existing Notification Row': [0, 0], 'Apply Status Notification Dedup': [1, 0],
        'Filter Status Persistable Transitions': [2, 0], 'Filter Status Held Actions': [2, 1],
        'Filter Status Terminal No-Write Actions': [1, 1],
      }),
      section('Persist and confirm intake notification', 'Writes order, history, and pending notification state before Gmail, then records success or an explicit pending failure.', 2688, 0, 9, [
        'Insert Intake Order Row', 'Insert Intake Status History Row', 'Insert Intake Notification Pending Row',
        'Send Controlled Intake Status Email', 'Build Intake Sent Updates', 'Update Intake Notification Sent',
        'Update Intake Order Notified', 'Build Intake Success Response', 'Respond Intake Success',
      ]),
      section('Persist transition and send when new', 'Writes every allowed transition and its History first, then only new notification keys continue to pending intent and Gmail.', 2688, 768, 8, [
        'Update Status Order Transition', 'Insert Status History Row', 'Filter Status Sendable Notifications', 'Insert Status Notification Pending Row',
        'Send Controlled Status Update Email', 'Build Status Sent Updates', 'Update Status Notification Sent',
        'Update Status Order Notified',
      ]),
      section('Return held, replay, and dedup outcomes', 'Persists held evidence, returns true no-write outcomes, and acknowledges a persisted re-entry without another notification or email.', 1600, 1536, 5, [
        'Insert Intake Held History Row', 'Build Intake Terminal Response', 'Respond Intake Terminal',
        'Insert Status Held History Row', 'Filter Status Persisted Without Email',
        'Build Status Terminal Response', 'Build Status Success Response', 'Respond Status Update',
      ], {
        'Insert Intake Held History Row': [0, 0], 'Build Intake Terminal Response': [1, 0], 'Respond Intake Terminal': [2, 0],
        'Insert Status Held History Row': [0, 1], 'Filter Status Persisted Without Email': [1, 1],
        'Build Status Terminal Response': [2, 1], 'Build Status Success Response': [3, 1],
        'Respond Status Update': [4, 1],
      }),
      section('Serve the safe customer projection', 'Looks up one tenant-scoped order by verifier and returns only the four documented customer-safe fields.', 0, 2304, 5, [
        'Customer Status Lookup Webhook', 'Normalize Status Lookup', 'Find Lookup Order Row',
        'Build Safe Lookup Response', 'Respond Customer Status Lookup',
      ]),
      section('Surface stale pending notifications', 'Finds old pending Order rows, builds an escaped age-based summary, and alerts the controlled inbox.', 1600, 2304, 5, [
        'Stale Order Sweep', 'Find Pending Notification Orders', 'Build Stale Pending Summary',
        'Stale Alert Needed?', 'Send Controlled Stale Alert',
      ]),
    ],
  },
  '11-quote-offer': {
    sectionTopPadding: 192,
    overviewTitle: 'Build itemized quotes with optional sales modules',
    overview: `## Build itemized quotes with optional sales modules

### How it works
1. Accepts the legacy single-service request or an itemized bundle of one to five unique services, then canonicalizes bundle order for replay-safe identity.
2. Resolves a versioned closed catalog, calculates every line and total in integer minor units, applies review policy, and renders an escaped itemized offer plus a hashed pricing snapshot.
3. Holds unknown services for review with no guessed total and blocks them from approval until the catalog is deliberately extended.
4. Reads every durable match before creating work, then stores client-send or operator-alert intent before Gmail and requires provider plus update evidence.
5. Protects approval with a separate token, records approve or reject evidence, and sweeps hourly for stale review or email-pending state.
6. Includes a disconnected manual lab for previewing Good/Better/Best choices, a deposit schedule, or a bounded CRM handoff payload without external action.

### Setup steps
- [ ] Create the Quote Offers Data Table with the documented schema and re-select it in every Data Table node.
- [ ] Set QUOTE_INTAKE_TOKEN and QUOTE_APPROVAL_TOKEN as separate n8n Variables.
- [ ] Connect Gmail and replace ops@example.test with your controlled operations inbox.
- [ ] Review the catalog, currency, policy threshold, offer table, approval expiry, and stale-state schedule.
- [ ] Run the customization lab only with synthetic data; copy an option into your own branch after review.

### Customization
Replace sample prices and wording while preserving canonical item identity, snapshot binding, integer minor units, all-row duplicate resolution, persist-before-send ordering, and provider-evidence gates.`,
    sections: [
      section('Build the itemized quote', 'Authenticates one request, validates shorthand or exact line items, then visibly resolves catalog, totals, policy, and escaped offer rendering.', 0, 0, 8, [
        'Quote Intake Webhook', 'Validate Quote Intake Token', 'Quote Intake Authorized?', 'Build Quote Intake Unauthorized Response',
        'Normalize Quote Request', 'Resolve Quote Catalog Items', 'Calculate Itemized Quote Totals',
        'Apply Quote Commercial Policy', 'Render Itemized Quote Offer', 'Quote Request Valid?', 'Build Quote Invalid Response',
      ]),
      section('Resolve replay and persist intent', 'Inspects every durable scope match, separates replay or conflict outcomes, and stores client-send or review-alert intent.', 2560, 0, 4, [
        'Find Existing Quote Rows', 'Resolve Quote Intake', 'Filter Quote Terminal Outcome', 'Filter New Standard Quote',
        'Filter New Review Quote', 'Build Quote Terminal Response', 'Insert Standard Send Intent', 'Insert Review Alert Intent',
      ]),
      section('Send the standard quote safely', 'Requires an acknowledged send intent, validates Gmail evidence, and confirms the matching delivery update before success.', 4096, 0, 5, [
        'Verify Standard Intent Acknowledgement', 'Send Standard Client Offer', 'Validate Standard Gmail Evidence',
        'Update Standard Offer Delivery', 'Build Standard Quote Response',
      ]),
      section('Alert review and return intake', 'Tracks the operator alert separately from client delivery and converges authenticated intake into one terminal response.', 5888, 0, 3, [
        'Verify Review Intent Acknowledgement', 'Send Quote Review Alert', 'Validate Review Alert Gmail Evidence',
        'Update Review Alert Delivery', 'Build Review Quote Response', 'Respond Quote Outcome',
      ]),
      section('Protect and validate approval', 'Authenticates the independent decision lane and validates exact scope, event identity, action, actor, note, and time.', 0, 768, 4, [
        'Quote Approval Webhook', 'Validate Quote Approval Token', 'Quote Approval Authorized?', 'Build Quote Approval Unauthorized Response',
        'Normalize Quote Approval', 'Quote Approval Valid?', 'Build Quote Approval Invalid Response',
      ]),
      section('Resolve the approval action', 'Reads every matching quote and classifies safe replay, conflict, reject, expiry, or approval-send outcomes without picking first.', 1536, 768, 4, [
        'Find Approval Quote Rows', 'Resolve Quote Approval', 'Filter Approval Terminal Outcome', 'Filter Approval Rejection',
        'Filter Approval Expiry', 'Filter Approval Send', 'Build Approval Terminal Response',
      ]),
      section('Persist rejection or expiry', 'Writes a compare-and-set terminal decision and verifies exactly one matching durable acknowledgement before responding.', 3072, 768, 3, [
        'Build Quote Rejection Update', 'Update Quote Rejected', 'Verify Rejection Acknowledgement',
        'Build Quote Expiry Update', 'Update Quote Expired', 'Verify Expiry Acknowledgement',
      ]),
      section('Persist and deliver approval', 'Acknowledges approval-send intent before Gmail, validates provider evidence, and confirms one exact final delivery update.', 4352, 768, 4, [
        'Build Approval Send Intent', 'Update Approval Send Intent', 'Verify Approval Send Intent', 'Send Approved Client Offer',
        'Validate Approved Gmail Evidence', 'Update Approved Offer Delivery', 'Build Approval Send Response', 'Respond Approval Outcome',
      ]),
      section('Detect stale durable state', 'Groups observable rows deterministically, isolates ambiguous duplicates, and persists each alert attempt before email.', 0, 1536, 3, [
        'Quote Observability Schedule', 'Find Observable Quote Rows', 'Build Stale Quote Alerts',
        'Stale Quote Alert Needed?', 'Emit Stale Alert Intent Rows', 'Update Stale Alert Intent',
      ]),
      section('Send and confirm stale alerts', 'Requires every intent acknowledgement, validates operator Gmail evidence, and advances only the matching pending throttle bucket.', 1280, 1536, 5, [
        'Build Stale Quote Alert Email', 'Send Stale Quote Alert', 'Validate Stale Alert Gmail Evidence',
        'Emit Stale Alert Sent Rows', 'Update Stale Alert Sent',
      ]),
      section('Preview optional quote variations', 'Runs an isolated synthetic fixture into three pure, integer-safe previews without credentials, provider calls, durable state, or CRM synchronization.', 0, 2304, 5, [
        'Try Quote Customizations', 'Build Safe Quote Customization Fixture',
        'OPTION — Build Good Better Best Choices', 'OPTION — Add Deposit Schedule',
        'OPTION — Build CRM Handoff Payload',
      ]),
    ],
  },
  '07-ksef-exception-desk': {
    enforceEdgeCorridors: true,
    overviewTitle: 'Handle KSeF exceptions without blind resubmission',
    overview: `## Handle KSeF exceptions without blind resubmission

### How it works
1. Authenticates invoice intake and persists each valid or rejected request as an immutable JSON snapshot with its SHA-256 hash; intake never reaches submission directly.
2. Uses one manual trigger and a three-output selector to run exactly one submission, recovery, or intake-fixture branch per manual execution.
3. Rereads lifecycle state for submission, enforces legal and operational preconditions, writes durable intent first, and then calls the bundled mock adapter.
4. Appends every transition to lifecycle and evidence, writes run summaries, and adds exception rows only for failures.
5. Runs recovery from the selector or every 30 minutes and queries status by client submission id before considering any retry.
6. Adopts accepted references and UPOs, permits one retry only after authoritative NOT_FOUND, holds unknown or error responses, and alerts on aged unresolved work.

### Setup steps
- [ ] Create and re-select the four documented KSeF Data Tables.
- [ ] Set KSEF_INTAKE_TOKEN for the webhook path.
- [ ] Optionally set KSEF_MANUAL_SWEEP_MODE to submission, recovery, or intake_fixture; missing or unknown values default to submission.
- [ ] Connect Gmail and replace ops@example.com in both summary and recovery alert nodes.
- [ ] Review approval, whitelist, breaker, and auth-adapter policies.
- [ ] Exercise the built-in synthetic submission and recovery scenarios while inactive.

### Customization
Replace the mock submit and status adapters with your KSeF integration, preserving immutable snapshots, query-before-retry, intent-before-side-effect, and single-run concurrency controls.`,
    sections: [
      section('Protect and select entrances', 'Authenticates webhook intake and routes each manual execution into exactly one controlled sweep branch.', 0, 0, 6, [
        'KSeF Intake Webhook', 'Validate Intake Token', 'Intake Authorized?', 'Build Webhook KSeF Fixture',
        'Build Unauthorized Response', 'Respond Unauthorized', 'KSeF Manual Sweep', 'Route Manual Sweep',
        'Build Intake Persist Fixtures',
      ], {
        'Build Unauthorized Response': [3, 1], 'Respond Unauthorized': [4, 1],
        'KSeF Manual Sweep': [0, 2], 'Route Manual Sweep': [1, 2], 'Build Intake Persist Fixtures': [5, 2],
      }),
      section('Plan guarded intake persistence', 'Reads lifecycle state and plans immutable, idempotent intake rows without submitting an invoice.', 1856, 0, 2, [
        'Get Intake Lifecycle Guard', 'Run Intake Persist Planner',
      ]),
      section('Persist the intake audit trail', 'Fans planned lifecycle, evidence, exception, and summary rows into four durable stores.', 2688, 0, 2, [
        'Emit Intake Lifecycle Rows', 'Insert Intake Lifecycle Rows',
        'Emit Intake Evidence Rows', 'Insert Intake Evidence Rows',
        'Emit Intake Exception Rows', 'Insert Intake Exception Rows',
        'Emit Intake Summary Row', 'Insert Intake Summary Row',
      ]),
      section('Acknowledge controlled intake', 'Optionally sends the controlled summary and returns the webhook persistence receipt.', 3520, 1280, 4, [
        'Intake Response Required?', 'Send Controlled Intake Summary', 'Build Webhook Response', 'Respond Accepted',
      ]),
      section('Gate durable submission', 'Rereads persisted lifecycle rows, writes submit intent first, and only then calls the bundled mock adapter.', 0, 1600, 5, [
        'Get Durable Entry Lifecycle Guard', 'Plan Durable Entry Guard', 'Insert Durable Entry State Rows',
        'Run Mock Submit After Durable Intent',
      ], {
        'Get Durable Entry Lifecycle Guard': [2, 0], 'Plan Durable Entry Guard': [3, 0],
        'Insert Durable Entry State Rows': [4, 0], 'Run Mock Submit After Durable Intent': [4, 1],
      }),
      section('Persist submission outcomes', 'Stores lifecycle, evidence, and summary rows for outcomes, adding exception rows only for failures.', 1600, 1600, 2, [
        'Emit Durable Terminal Lifecycle Rows', 'Insert Durable Terminal Lifecycle Rows',
        'Emit Durable Evidence Rows', 'Insert Durable Evidence Rows',
        'Emit Durable Exception Rows', 'Insert Durable Exception Rows',
        'Emit Durable Summary Row', 'Insert Durable Summary Row',
      ]),
      section('Enter query-first recovery', 'Converges manual and scheduled triggers on lifecycle state and a status-before-retry decision.', 0, 2944, 4, [
        'Get Durable Recovery Lifecycle Rows', 'Run Durable Recovery Sweep', 'Durable Recovery Schedule',
      ], { 'Get Durable Recovery Lifecycle Rows': [0, 0], 'Run Durable Recovery Sweep': [1, 0], 'Durable Recovery Schedule': [0, 1] }),
      section('Persist recovery decisions', 'Stores adopted UPOs, safe retries, unresolved holds, evidence, exceptions, and the sweep summary.', 1344, 2944, 2, [
        'Emit Recovery Lifecycle Rows', 'Insert Recovery Lifecycle Rows',
        'Emit Recovery Evidence Rows', 'Insert Recovery Evidence Rows',
        'Emit Recovery Exception Rows', 'Insert Recovery Exception Rows',
        'Emit Recovery Summary Row', 'Insert Recovery Summary Row',
      ]),
      section('Alert on aged recovery', 'Gates aged unresolved work, sends Gmail, and records the throttle only after the send step succeeds.', 2176, 4288, 3, [
        'Recovery Alert Required?', 'Send Controlled Recovery Alert', 'Record Recovery Alert Throttle',
      ]),
    ],
  },
  '04-support-triage': {
    // Preserve the already-published artifact. New templates use the safer defaults above.
    acceptedLegacyLayout: true,
    acceptedArtifactSha256: '74ca9414dc93468bc128eb156312c22551b5ff5c0d98f415935fd730a1866225',
    sectionTopPadding: LEGACY_SECTION_TOP_PADDING,
    overviewSize: { width: 800, height: 640 },
    sectionBottomPadding: 64,
    overviewTitle: 'Triage support requests and draft grounded replies',
    overview: `## Triage support requests and draft grounded replies

### How it works
1. Receives a support request, validates a dedicated token, redacts sensitive patterns, and matches the question against a closed knowledge base.
2. Sends knowledge-base misses and failed model validations to a human instead of inventing an answer.
3. Uses OpenAI only for matched questions, then verifies the cited source, intent, confidence, and unsafe phrasing.
4. Stores every successful answer as a draft; only a separate, token-protected approval webhook can send a reviewed reply.
5. Retries unconfirmed operator alerts without making intake-generated drafts sendable.

### Setup steps
- [ ] Create and re-select the \`Support_Tickets\` and \`Support_KB_Learnings\` Data Tables.
- [ ] Set separate intake and approval tokens in n8n Variables.
- [ ] Connect Gmail and OpenAI credentials and replace \`ops@example.com\`.
- [ ] Replace the demo knowledge-base array with your reviewed entries.
- [ ] Test a miss, duplicate, injection-style message, approval, edit, and rejection while inactive.

### Customization
Adjust the knowledge base, match and confidence thresholds, validation denylist, learning-capture policy, and controlled test inbox before production use.`,
    sections: [
      section('Receive and deduplicate request', 'Authenticates intake, redacts and normalizes the question, and returns existing results for replays.', 0, 0, 6, [
        'Support Intake Webhook', 'Validate Support Intake Token', 'Support Intake Authorized?', 'Respond Support Intake Unauthorized',
        'Normalize Support Intake', 'Claim Support Ticket Key', 'Support Claim Duplicate?', 'Find Claimed Support Row',
        'Find Existing Support Row', 'Persistent Support Duplicate?', 'Respond Support Duplicate',
      ]),
      section('Ground and validate draft', 'Matches the closed knowledge base, drafts from retrieved content, and validates the model output.', 1856, 0, 5, [
        'Support KB Match?', 'Draft Grounded Reply', 'Validate Grounded Draft', 'Insert Support Draft State', 'Validated Draft Ready?',
      ]),
      section('Deliver draft alert', 'Notifies the operator about a valid draft and records confirmed review-alert delivery.', 3456, 0, 6, [
        'Build Draft Review Alert', 'Send Controlled Draft Review Alert', 'Build Draft Alert Update',
        'Update Draft Alert Sent', 'Mark Support Claim Draft', 'Respond Support Draft Ready',
      ]),
      section('Escalate unsafe request', 'Persists KB misses or failed drafts, alerts the operator, and returns an escalated result.', 5312, 0, 7, [
        'Insert Support Escalation', 'Build Escalation Review Alert', 'Send Controlled Escalation Alert',
        'Build Escalation Alert Update', 'Update Escalation Alert Sent', 'Mark Support Claim Escalated', 'Respond Support Escalated',
      ]),
      section('Receive approval decision', 'Authenticates and validates the separate human-review action before claiming it once.', 0, 640, 8, [
        'Support Approval Webhook', 'Validate Support Approval Token', 'Support Approval Authorized?',
        'Respond Support Approval Unauthorized', 'Normalize Support Approval', 'Approval Input Valid?',
        'Respond Approval Invalid', 'Claim Approval Action',
      ]),
      section('Load approvable ticket', 'Rejects duplicate or stale actions and decides whether the reviewed action may send a reply.', 2368, 640, 6, [
        'Approval Duplicate?', 'Respond Approval Duplicate', 'Find Review Ticket Row',
        'Ticket Approvable?', 'Respond Ticket Not Approvable', 'Approval Sends Reply?',
      ]),
      section('Record no-send decision', 'Persists reject or escalate decisions and responds without sending any customer message.', 4224, 640, 3, [
        'Build Approval Decision Update', 'Update Approval Decision', 'Respond Approval Decision Recorded',
      ]),
      section('Send approved reply', 'Marks the send pending, delivers the reviewed text, records success, and chooses learning capture.', 5312, 640, 7, [
        'Build Approval Pre-Send Update', 'Update Approval Pending Send', 'Build Controlled Reply Email',
        'Send Controlled Support Reply', 'Build Sent Update', 'Update Support Sent', 'Learning Capture Allowed?',
      ]),
      section('Finish approved action', 'Optionally stores the approved Q&A pair and returns the matching successful response.', 5312, 1024, 4, [
        'Build Learning Capture Row', 'Insert KB Learning', 'Respond Approval Sent With Learning', 'Respond Approval Sent No Learning',
      ]),
      section('Retry review alerts', 'Finds unconfirmed operator alerts, retries delivery, and updates only alert metadata.', 0, 1024, 6, [
        'Support Review Alert Reconciliation Sweep', 'Find Unsent Support Review Alerts', 'Build Unsent Support Review Alert',
        'Send Reconciled Support Review Alert', 'Build Reconciled Support Alert Update', 'Update Reconciled Support Alert Sent',
      ]),
    ],
  },
};

function section(title, description, x, y, columns, nodes, placements = {}) {
  return { title, description, x, y, columns, nodes, placements };
}

function sectionPlacement(group, name, nodeIndex) {
  return group.placements[name] ?? [nodeIndex % group.columns, Math.floor(nodeIndex / group.columns)];
}

function sectionRows(group) {
  return Math.max(...group.nodes.map((name, nodeIndex) => sectionPlacement(group, name, nodeIndex)[1])) + 1;
}

function stableId(key) {
  const hex = createHash('sha256').update(`kuliberda-creators:${key}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function sourcePath(slug) {
  return resolve(ROOT, 'workflows', slug, 'workflow.json');
}

function outputPath(slug) {
  return resolve(ROOT, 'workflows', slug, 'workflow-annotated-v2.json');
}

function build(slug) {
  const spec = requireSpec(slug);
  const overviewSize = spec.overviewSize ?? DEFAULT_OVERVIEW_SIZE;
  const sectionBottomPadding = spec.sectionBottomPadding ?? DEFAULT_SECTION_BOTTOM_PADDING;
  const sectionTopPadding = spec.sectionTopPadding ?? DEFAULT_SECTION_TOP_PADDING;
  const source = JSON.parse(readFileSync(sourcePath(slug), 'utf8'));
  const functional = structuredClone(source.nodes.filter((node) => node.type !== STICKY_TYPE));
  const byName = new Map(functional.map((node) => [node.name, node]));

  for (const [sectionIndex, group] of spec.sections.entries()) {
    group.nodes.forEach((name, nodeIndex) => {
      const node = byName.get(name);
      if (!node) throw new Error(`${slug}: section ${sectionIndex + 1} names missing node: ${name}`);
      const [column, row] = sectionPlacement(group, name, nodeIndex);
      node.position = [group.x + 64 + column * 256, group.y + sectionTopPadding + row * 256];
    });
  }

  const overview = {
    id: stableId(`${slug}:overview`),
    name: `Overview — ${spec.overviewTitle}`,
    type: STICKY_TYPE,
    typeVersion: 1,
    position: [-overviewSize.width - 128, 0],
    parameters: { content: spec.overview, ...overviewSize },
  };

  const stickies = spec.sections.map((group, index) => {
    const rows = sectionRows(group);
    return {
      id: stableId(`${slug}:section:${index + 1}`),
      name: `Section ${index + 1} — ${group.title}`,
      type: STICKY_TYPE,
      typeVersion: 1,
      position: [group.x, group.y],
      parameters: {
        content: `## ${group.title}\n${group.description}`,
        width: group.columns * 256 + 256,
        height: rows * 256 + sectionBottomPadding + sectionTopPadding - LEGACY_SECTION_TOP_PADDING,
        color: 7,
      },
    };
  });

  const artifact = { ...source, nodes: [overview, ...stickies, ...functional] };
  validate(slug, source, artifact);
  writeFileSync(outputPath(slug), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`BUILT ${slug}: ${outputPath(slug)}`);
}

function validate(slug, source, artifact) {
  const spec = requireSpec(slug);
  const overviewSize = spec.overviewSize ?? DEFAULT_OVERVIEW_SIZE;
  const sectionBottomPadding = spec.sectionBottomPadding ?? DEFAULT_SECTION_BOTTOM_PADDING;
  const sectionTopPadding = spec.sectionTopPadding ?? DEFAULT_SECTION_TOP_PADDING;
  const sourceFunctional = source.nodes.filter((node) => node.type !== STICKY_TYPE);
  const sourceStickies = source.nodes.filter((node) => node.type === STICKY_TYPE);
  const artifactFunctional = artifact.nodes.filter((node) => node.type !== STICKY_TYPE);
  const stickies = artifact.nodes.filter((node) => node.type === STICKY_TYPE);
  const overview = stickies.filter((node) => node.parameters.color === undefined);
  const sections = stickies.filter((node) => node.parameters.color === 7);
  const errors = [];

  if (sourceStickies.length) errors.push(`canonical source contains ${sourceStickies.length} sticky notes; refusing to drop them implicitly`);
  const normalized = (nodes) => nodes.map(({ position, ...node }) => node);
  if (JSON.stringify(normalized(sourceFunctional)) !== JSON.stringify(normalized(artifactFunctional))) {
    errors.push('functional node payload changed outside position');
  }
  if (JSON.stringify(source.connections) !== JSON.stringify(artifact.connections)) errors.push('connections changed');
  const sourceTop = { ...source }; delete sourceTop.nodes;
  const artifactTop = { ...artifact }; delete artifactTop.nodes;
  if (JSON.stringify(sourceTop) !== JSON.stringify(artifactTop)) errors.push('top-level workflow state changed');
  if (overview.length !== 1) errors.push(`expected one yellow overview, found ${overview.length}`);
  if (sections.length !== spec.sections.length) errors.push(`expected ${spec.sections.length} white sections, found ${sections.length}`);
  if (stickies.length !== 1 + spec.sections.length) errors.push(`expected only overview plus ${spec.sections.length} white sections, found ${stickies.length} stickies`);
  if (overview[0]?.parameters.width !== overviewSize.width || overview[0]?.parameters.height !== overviewSize.height) {
    errors.push(`overview must be ${overviewSize.width}x${overviewSize.height} for the current renderer`);
  }
  if (overview[0]?.id !== stableId(`${slug}:overview`)) errors.push('overview id differs from deterministic spec');
  if (overview[0]?.name !== `Overview — ${spec.overviewTitle}`) errors.push('overview name differs from spec');
  if (overview[0]?.parameters.content !== spec.overview) errors.push('overview content differs from spec');
  if (JSON.stringify(overview[0]?.position) !== JSON.stringify([-overviewSize.width - 128, 0])) errors.push('overview position differs from spec');

  const words = overview[0]?.parameters.content.trim().split(/\s+/).length ?? 0;
  if (words < 100 || words > 300) errors.push(`overview word count ${words} is outside 100-300`);

  const expectedNames = spec.sections.flatMap((group) => group.nodes);
  const sourceNames = sourceFunctional.map((node) => node.name);
  const functionalNames = artifactFunctional.map((node) => node.name);
  if (new Set(sourceNames).size !== sourceNames.length) errors.push('canonical functional node names are not unique');
  if (new Set(expectedNames).size !== expectedNames.length) errors.push('manual section map contains duplicate node names');
  for (const name of functionalNames) {
    if (!expectedNames.includes(name)) errors.push(`functional node missing from manual section map: ${name}`);
  }
  for (const name of expectedNames) {
    if (!functionalNames.includes(name)) errors.push(`manual section map names unknown node: ${name}`);
  }
  const minimumSections = Math.ceil(sourceFunctional.length / 8);
  const maximumSections = Math.floor(sourceFunctional.length / 5);
  if (spec.sections.length < minimumSections || spec.sections.length > maximumSections) {
    errors.push(`balanced grouping has ${spec.sections.length} sections, expected ${minimumSections}-${maximumSections}`);
  }
  const microSections = spec.sections.filter((group) => group.nodes.length <= 2);
  if (microSections.length > 1) {
    errors.push(`balanced grouping has ${microSections.length} one/two-node sections, expected at most one exceptional small stage`);
  }
  for (const [index, group] of spec.sections.entries()) {
    if (group.nodes.length > 11) {
      errors.push(`section ${index + 1}: balanced group has ${group.nodes.length} nodes, expected at most 11`);
    }
  }
  if (sectionTopPadding === LEGACY_SECTION_TOP_PADDING && !spec.acceptedLegacyLayout) {
    errors.push(`legacy ${LEGACY_SECTION_TOP_PADDING}px section top padding is allowed only for an unchanged accepted artifact`);
  }
  if (spec.acceptedLegacyLayout && !spec.acceptedArtifactSha256) {
    errors.push('accepted legacy layout requires an acceptedArtifactSha256 pin');
  }

  const rect = (node) => ({
    x1: node.position[0], y1: node.position[1],
    x2: node.position[0] + (node.parameters.width ?? NODE_SIZE),
    y2: node.position[1] + (node.parameters.height ?? NODE_SIZE),
  });
  const contains = (outer, inner) => outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;
  const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const segmentIntersects = (start, end, box) => {
    let low = 0;
    let high = 1;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    for (const [p, q] of [[-dx, start.x - box.x1], [dx, box.x2 - start.x], [-dy, start.y - box.y1], [dy, box.y2 - start.y]]) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      const ratio = q / p;
      if (p < 0) {
        if (ratio > high) return false;
        if (ratio > low) low = ratio;
      } else {
        if (ratio < low) return false;
        if (ratio < high) high = ratio;
      }
    }
    return true;
  };
  const segmentsProperlyIntersect = (first, second) => {
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const firstStartSide = cross(first.start, first.end, second.start);
    const firstEndSide = cross(first.start, first.end, second.end);
    const secondStartSide = cross(second.start, second.end, first.start);
    const secondEndSide = cross(second.start, second.end, first.end);
    return firstStartSide * firstEndSide < 0 && secondStartSide * secondEndSide < 0;
  };

  for (const node of artifactFunctional) {
    const coverage = sections.filter((sticky) => contains(rect(sticky), rect(node))).length;
    if (coverage !== 1) errors.push(`${node.name}: geometry coverage is ${coverage}, expected 1`);
  }
  for (let i = 0; i < sections.length; i += 1) {
    const group = spec.sections[i];
    const sticky = sections[i];
    const expectedRows = sectionRows(group);
    const expectedContent = `## ${group.title}\n${group.description}`;
    if (sticky?.id !== stableId(`${slug}:section:${i + 1}`)) errors.push(`section ${i + 1}: id differs from deterministic spec`);
    if (sticky?.name !== `Section ${i + 1} — ${group.title}`) errors.push(`section ${i + 1}: name differs from spec`);
    if (sticky?.parameters.content !== expectedContent) errors.push(`section ${i + 1}: content differs from spec`);
    if (JSON.stringify(sticky?.position) !== JSON.stringify([group.x, group.y])) errors.push(`section ${i + 1}: position differs from spec`);
    const expectedHeight = expectedRows * 256 + sectionBottomPadding + sectionTopPadding - LEGACY_SECTION_TOP_PADDING;
    if (sticky?.parameters.width !== group.columns * 256 + 256 || sticky?.parameters.height !== expectedHeight) {
      errors.push(`section ${i + 1}: dimensions differ from spec`);
    }
    if (sticky?.parameters.width < MIN_SECTION_WIDTH) {
      errors.push(`section ${i + 1}: width is ${sticky.parameters.width}, expected at least ${MIN_SECTION_WIDTH}`);
    }
    const assignedNames = new Set(group.nodes);
    const coveredNames = artifactFunctional.filter((node) => contains(rect(sticky), rect(node))).map((node) => node.name);
    const wrongCoverage = coveredNames.length !== assignedNames.size || coveredNames.some((name) => !assignedNames.has(name));
    if (wrongCoverage) errors.push(`section ${i + 1}: geometry does not match its declared node map`);
    group.nodes.forEach((name, nodeIndex) => {
      const [column, row] = sectionPlacement(group, name, nodeIndex);
      if (!Number.isInteger(column) || column < 0 || column >= group.columns || !Number.isInteger(row) || row < 0) {
        errors.push(`section ${i + 1}: ${name} has invalid declared placement [${column}, ${row}]`);
        return;
      }
      const node = artifactFunctional.find((candidate) => candidate.name === name);
      const expectedPosition = [group.x + 64 + column * 256, group.y + sectionTopPadding + row * 256];
      if (node && JSON.stringify(node.position) !== JSON.stringify(expectedPosition)) {
        errors.push(`${name}: position differs from declared section placement`);
      }
    });
    for (let j = i + 1; j < sections.length; j += 1) {
      if (overlaps(rect(sections[i]), rect(sections[j]))) errors.push(`${sections[i].name} overlaps ${sections[j].name}`);
    }
  }

  if (spec.enforceEdgeCorridors) {
    const byFunctionalName = new Map(artifactFunctional.map((node) => [node.name, node]));
    const edges = [];
    for (const [sourceName, connectionTypes] of Object.entries(artifact.connections ?? {})) {
      for (const outputs of Object.values(connectionTypes ?? {})) {
        for (const output of outputs ?? []) {
          for (const connection of output ?? []) {
            const sourceNode = byFunctionalName.get(sourceName);
            const targetNode = byFunctionalName.get(connection.node);
            if (!sourceNode || !targetNode) continue;
            const sourceRect = rect(sourceNode);
            const targetRect = rect(targetNode);
            const movesRight = targetNode.position[0] >= sourceNode.position[0];
            const start = { x: movesRight ? sourceRect.x2 : sourceRect.x1, y: (sourceRect.y1 + sourceRect.y2) / 2 };
            const end = { x: movesRight ? targetRect.x1 : targetRect.x2, y: (targetRect.y1 + targetRect.y2) / 2 };
            edges.push({ sourceName, targetName: connection.node, start, end });
            for (const other of artifactFunctional) {
              if (other === sourceNode || other === targetNode) continue;
              if (segmentIntersects(start, end, rect(other))) {
                errors.push(`${sourceName} -> ${connection.node}: direct edge corridor crosses ${other.name}`);
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < edges.length; i += 1) {
      for (let j = i + 1; j < edges.length; j += 1) {
        const first = edges[i];
        const second = edges[j];
        const firstEndpoints = new Set([first.sourceName, first.targetName]);
        if (firstEndpoints.has(second.sourceName) || firstEndpoints.has(second.targetName)) continue;
        if (segmentsProperlyIntersect(first, second)) {
          errors.push(`${first.sourceName} -> ${first.targetName} crosses ${second.sourceName} -> ${second.targetName}`);
        }
      }
    }
  }

  if (overview[0]) {
    for (const sticky of sections) {
      if (overlaps(rect(overview[0]), rect(sticky))) errors.push(`${overview[0].name} overlaps ${sticky.name}`);
    }
    for (const node of artifactFunctional) {
      if (overlaps(rect(overview[0]), rect(node))) errors.push(`${overview[0].name} overlaps ${node.name}`);
    }
  }

  const allNumbers = artifact.nodes.flatMap((node) => [
    ...node.position,
    ...(node.type === STICKY_TYPE ? [node.parameters.width, node.parameters.height] : []),
  ]);
  if (allNumbers.some((value) => !Number.isFinite(value) || value % 16 !== 0)) errors.push('positions or sticky dimensions are invalid or off the 16 px grid');
  for (let i = 0; i < artifactFunctional.length; i += 1) {
    for (let j = i + 1; j < artifactFunctional.length; j += 1) {
      if (overlaps(rect(artifactFunctional[i]), rect(artifactFunctional[j]))) {
        errors.push(`${artifactFunctional[i].name} overlaps ${artifactFunctional[j].name}`);
      }
    }
  }
  for (const sticky of sections) {
    if (sticky.parameters.content.split('\n').length > 2) errors.push(`${sticky.name}: section copy exceeds title plus one sentence`);
    const coveredNodes = artifactFunctional.filter((node) => contains(rect(sticky), rect(node)));
    const shallowestNodeTop = Math.min(...coveredNodes.map((node) => rect(node).y1), sticky.position[1] + sticky.parameters.height);
    const actualTopPadding = shallowestNodeTop - sticky.position[1];
    if (actualTopPadding < sectionTopPadding) {
      errors.push(`${sticky.name}: top text safety padding is ${actualTopPadding}, expected at least ${sectionTopPadding}`);
    }
    const deepestNodeBottom = Math.max(...coveredNodes.map((node) => rect(node).y2), sticky.position[1]);
    const actualBottomPadding = sticky.position[1] + sticky.parameters.height - deepestNodeBottom;
    if (actualBottomPadding < sectionBottomPadding) {
      errors.push(`${sticky.name}: bottom text safety padding is ${actualBottomPadding}, expected at least ${sectionBottomPadding}`);
    }
  }

  if (errors.length) throw new Error(`${slug} validation failed:\n- ${errors.join('\n- ')}`);
  console.log(`PASS ${slug}: ${artifactFunctional.length} functional nodes, ${sections.length} white sections, overview ${words} words`);
}

function verifyAcceptedArtifactPin(slug, rawArtifact, spec = requireSpec(slug)) {
  if (!spec.acceptedLegacyLayout) return;
  if (!spec.acceptedArtifactSha256) {
    throw new Error(`${slug}: accepted legacy layout requires an acceptedArtifactSha256 pin`);
  }
  const actualSha256 = createHash('sha256').update(rawArtifact).digest('hex');
  if (actualSha256 !== spec.acceptedArtifactSha256) {
    throw new Error(`${slug}: accepted legacy artifact SHA-256 ${actualSha256} does not match pinned ${spec.acceptedArtifactSha256}`);
  }
}

function check(slug) {
  const source = JSON.parse(readFileSync(sourcePath(slug), 'utf8'));
  const rawArtifact = readFileSync(outputPath(slug));
  verifyAcceptedArtifactPin(slug, rawArtifact);
  const artifact = JSON.parse(rawArtifact.toString('utf8'));
  validate(slug, source, artifact);
}

function requireSpec(slug) {
  const spec = WORKFLOWS[slug];
  if (!spec) throw new Error(`Unknown workflow: ${slug}. Available: ${Object.keys(WORKFLOWS).join(', ')}`);
  return spec;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  const [command, requested] = process.argv.slice(2);
  const slugs = requested ? [requested] : Object.keys(WORKFLOWS);
  if (!['build', 'check'].includes(command)) {
    console.error('Usage: node scripts/creators-annotations.mjs <build|check> [workflow-slug]');
    process.exit(2);
  }
  for (const slug of slugs) command === 'build' ? build(slug) : check(slug);
}

export { WORKFLOWS, build, check, validate, verifyAcceptedArtifactPin };
