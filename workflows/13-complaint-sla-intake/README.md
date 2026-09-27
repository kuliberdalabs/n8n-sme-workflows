# Complaint Intake and Owned SLA

An inactive n8n template for teams that need every complaint to have an owner and a visible response deadline. It accepts metadata, records a case in a Data Table, escalates unanswered ownership requests, and sends internal Gmail alerts. An owner can acknowledge the case or close it with a resolution reference. There is no AI and no customer-send path.

## Two independent clocks

**Ownership SLA:** the first role is `owner`. If it does not acknowledge within the configured interval (two hours by default), the next sweep assigns `lead`, then `manager` after another interval. An initial internal alert is sent on the first eligible sweep. The manager receives daily reminders while ownership remains unacknowledged. These are business elapsed-time timers, including nights and weekends.

**Response deadline:** the caller supplies an explicit timestamp and policy reference, or supplies `null` and an empty reference when the deadline needs review. The workflow alerts within 72 hours, within 24 hours, at breach, and daily after breach. A newly observed more urgent threshold supersedes earlier unsent thresholds. Missing deadlines produce an internal review alert. An owner acknowledgement never stops this clock. A confirmed close action stops future alerts.

The workflow does not classify legal applicability, calculate statutory periods, count legal business days, decide whether a complaint is valid, or make a compliance guarantee. The source system or authorized person determines the deadline and records the policy reference. It must supply the actual receipt timestamp, including an explicit timezone offset. There is no universal 14-day default.

## Setup

1. Import `workflow-annotated-v2.json` into n8n and keep it inactive. In Workflow settings, confirm timezone **UTC**, execution logic **v1**, and **Do not save** for failed production, successful production and manual executions. The editor's Import from file action in n8n 2.37.10 imports the graph but keeps the destination workflow settings, so reapply these settings before sending any requests.
2. Create `Complaint_Cases` and `Complaint_Alerts` using the column lists below. Select them in every Data Table node; the supplied IDs are placeholders.
3. Create the n8n Variables below. This template requires an n8n installation with Variables available. Self-hosted Code nodes also need the `crypto` built-in enabled.
4. Attach a Gmail OAuth credential to `Send Internal Complaint Alert`. Configure only internal team inboxes during the pilot.
5. Have your source system send the exact intake contract. Keep original complaint content and attachments in that source system; references must be opaque identifiers, not names, emails or sensitive text.
6. Use synthetic references and internal test inboxes to exercise the checks below before activation.
7. Serialize intake deliveries, owner actions and sweeps for this lane, or replace the Data Tables with transactional storage before concurrent production use.

### Variables

| Variable | Purpose |
|---|---|
| `COMPLAINT_INTAKE_TOKEN` | Bearer token for the source-system intake lane |
| `COMPLAINT_OWNER_TOKEN` | Bearer token for the `owner` role |
| `COMPLAINT_LEAD_TOKEN` | Bearer token for the `lead` role |
| `COMPLAINT_MANAGER_TOKEN` | Bearer token for the `manager` role |
| `COMPLAINT_OWNER_EMAIL` | Internal inbox for initial owner alerts |
| `COMPLAINT_LEAD_EMAIL` | Internal inbox for first escalation |
| `COMPLAINT_MANAGER_EMAIL` | Internal inbox for final escalation |
| `COMPLAINT_ACK_SLA_HOURS` | Optional integer 1–168; default 2 elapsed hours |

Each token must be 24–256 characters. All three owner-role tokens must be configured, distinct from each other and distinct from the intake token. Use generated secrets, not the illustrative values in tests. All webhooks require exactly one `Authorization: Bearer <token>` header. Owner identity is derived from the matched server-side role token; a caller-supplied actor field grants no authority. These are role credentials, not individual SSO or tenant-level authorization. One configured team owns the entire lane.

## Intake contract

`POST /webhook/complaint-sla-intake`

```json
{
  "tenant_id": "tenant-example",
  "source_ref": "ticket-013",
  "category": "complaint",
  "received_at_utc": "2026-09-07T08:00:00Z",
  "response_due_at_utc": "2026-09-10T16:00:00+02:00",
  "policy_ref": "response-policy-v1"
}
```

The six fields are required; any additional field rejects the request. `category` is exactly `complaint`, `reclamation`, or `other`, supplied by the trusted source, with no keyword/AI inference. The category does not select urgency or a legal deadline.

`tenant_id` is 1–64 characters, `source_ref` 1–128, and `policy_ref` 1–80 when present. These references use `[A-Za-z0-9][A-Za-z0-9._:-]*`. Timestamps require a real date, seconds, and `Z` or a numeric timezone offset. Receipt time cannot be more than five minutes in the future. A supplied deadline must follow receipt time; past deadlines are accepted and alert as breached. To route a missing deadline for review, use `response_due_at_utc: null` and `policy_ref: ""`.

The case key is SHA-256 of `tenant_id + "\n" + source_ref`. A second hash binds the normalized metadata. A sequential exact retry returns the existing case without another insert. A changed payload under the same key returns `409 identity_conflict`; multiple or invalid physical rows return `409 ambiguous_case_reconcile_required`. No success response is returned until the inserted row is acknowledged with the expected values.

A new case returns `201 created`, its key, current revision, owner role, deadline status and a generic acknowledgement text for manual use. The workflow does not send that acknowledgement or persist a customer response draft. Invalid inputs return `400`; unauthorized requests return `401`; uncertain intake persistence returns `503`.

## Owner actions

`POST /webhook/complaint-sla-owner-action`, authenticated with the **currently assigned role's** token:

```json
{
  "case_key": "<64-character case key from intake>",
  "action": "ack",
  "expected_revision": 1,
  "resolution_ref": ""
}
```

For closure, use `action: "close"` and a nonempty opaque `resolution_ref` (1–128 characters), such as the ID of the source-system record documenting the actual response or resolution. Closing is an authorized human declaration: the template does not inspect that record or prove that a response was legally sufficient or delivered.

Find the latest revision and owner in `Complaint_Cases`; internal alerts also include the revision at alert planning time. A different role receives `403`; a stale revision receives `409`. Exact repeats of an already-applied acknowledgement or closure return the existing result without another write. Acknowledgement preserves the response deadline. Closing ends future ownership and deadline reminders. There is no reopen action.

For a missing or corrected deadline, an authorized operator must verify the source-system policy, pause this lane, update `response_due_at_utc` and `policy_ref` together in `Complaint_Cases`, increment `revision`, and reconcile the related alert history before resuming. Intake replay deliberately does not overwrite established cases. Automated deadline changes and their approval UI are outside this template.

## Data Table schemas

Create columns exactly as listed. n8n supplies the physical `id` and system timestamps; do not create them yourself. The JSON's mapping schema defines the same types.

### Complaint_Cases

String columns:

- `case_key`, `intake_fingerprint`, `tenant_id`, `source_ref`, `category`
- `policy_ref`, `deadline_status`, `owner_id`, `ack_status`, `lifecycle_status`, `resolution_ref`

Number columns: `owner_level`, `ack_sla_hours`, `revision`.

Date columns:

- `received_at_utc`, `response_due_at_utc`
- `ack_at_utc`, `owner_assigned_at_utc`, `closed_at_utc`
- `created_at_utc`, `updated_at_utc`

Placeholder: `REPLACE_WITH_COMPLAINT_CASES_TABLE_ID`.

### Complaint_Alerts

String columns: `event_key`, `case_key`, `event_kind`, `event_status`, `owner_id`, `gmail_message_id`.

Date columns: `event_at_utc`, `updated_at_utc`.

Placeholder: `REPLACE_WITH_COMPLAINT_ALERTS_TABLE_ID`.

## Alert delivery and recovery

The 15-minute sweep reads open cases, rejects invalid or duplicate physical state, and processes them one at a time. It reloads each case and its alert history. Response-deadline events have priority; an ownership event can follow on the next sweep. A confirmed event suppresses its sequential replay.

Before Gmail, the workflow verifies a guarded case update, inserts an `intent` in `Complaint_Alerts`, and verifies that insert. Gmail success requires a message ID; an error or missing ID becomes `reconcile_required`. The returned ID is recorded and the update is verified. There is no automatic Gmail-node retry. `intent`, `reconcile_required`, ambiguous history or failed writes stop processing and surface an execution error rather than silently sending again. This can delay later cases in the sweep; configure n8n execution-error monitoring and handle it promptly.

**Recovery:** inspect the original internal mailbox and Gmail provider evidence for the specific case/event. If delivery is proven, record its real message ID and mark the alert `sent`. If delivery is proven not to have happened, pause the lane, preserve the incident evidence, and deliberately remove only that failed intent so a later sweep can recreate it. If the outcome is unknown, retain the intent and resolve the complaint manually. Never fabricate a provider ID or treat a timeout as proof of no send.

Owner assignment is persisted before the internal alert. If Gmail fails, the assigned role may already have changed; inspect the case table as well as the alert ledger during recovery. Closing a case does not recall an email already in flight.

## Privacy and operating limits

- The workflow does not accept or persist customer names, email addresses, complaint text, attachment names, URLs, or contents. Opaque source references still require an appropriate access and retention policy; hashing a reference does not guarantee anonymization.
- Internal alerts contain case key, assigned role, revision, deadline and policy reference only. The caller cannot choose recipients or message text.
- Successful, failed and manual execution-data saving is disabled in the supplied settings. Raw requests can still exist transiently, in upstream logging, or when an operator enables execution recording. Configure the environment accordingly.
- The Data Tables do not provide transactional uniqueness across this whole workflow. Guarded updates and exact row acknowledgements detect many stale/ambiguous results but do not guarantee atomic or exactly-once delivery. Concurrent first deliveries or overlapping operations can still race; serialized operation is required for this reference template.
- One role ladder and one set of credentials serve all supplied tenant references. This is a trusted team/source lane, not mutually isolated multi-tenant hosting.
- Alert thresholds are elapsed hours in UTC, sampled every 15 minutes. Downtime, execution errors, queue delay and missing credentials can delay alerts. There is no guaranteed legal-service clock or delivery SLA.
- Alert history grows until the operator applies a retention policy. Do not purge open-case history: doing so can re-enable duplicate alerts.
- No mailbox ingestion, source-system retrieval, automatic customer reply, refund, legal decision, or attachment processing is included.

## Verification scenarios

Run `node --test tests/complaint-sla-intake.test.js` from the repository root. Tests execute the real Code nodes and inspect the native graph. They cover malformed metadata/timestamps, identity replay/conflict, duplicate physical rows, role-token binding, stale ownership updates, acknowledgement versus response deadlines, closure, owner escalation, multi-case context, write acknowledgements and uncertain Gmail outcomes.

Before live use, additionally test your real Data Tables and internal Gmail credential with synthetic cases: intake → exact replay → owner ack → due alert while acked → close → no new alert; a second case must keep its own context during the same sweep. Test ambiguous provider outcomes without permitting automatic resend.
