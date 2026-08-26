# Booking Lifecycle

An inactive, import-ready n8n workflow for creating client kickoff bookings with durable replay handling, native Google Calendar availability and event operations, and Gmail drafts. It consumes the exact `kickoff_booking` request emitted by workflow 08 and writes the `Bookings` evidence that workflow 08 already understands.

## What it does

The production webhook accepts only these seven fields:

```json
{
  "booking_uid": "<onboarding_id>:kickoff:2026-09-01T09:00:00+02:00",
  "onboarding_id": "<64 lowercase hex characters>",
  "smoke_tag": "BOOKING-DRAFT",
  "verified_email": "client@example.test",
  "slot_start": "2026-09-01T09:00:00+02:00",
  "slot_end": "2026-09-01T10:00:00+02:00",
  "slot_tz": "Europe/Warsaw"
}
```

`booking_uid` must equal `onboarding_id + ":kickoff:" + slot_start`, exactly as workflow 08 derives it. `smoke_tag` is preserved byte-for-byte and must match the documented bounded identifier pattern. Start and end must be real civil timestamps with an explicit offset, the offset must agree with the IANA timezone at each instant, and start must precede end.

The workflow then:

1. Authenticates `x-booking-token` or `Authorization: Bearer …` against the server-side `BOOKING_INTAKE_TOKEN` variable before validation, Data Tables, Calendar, or Gmail.
2. Derives stable request bytes, a request hash, a parent-scope key from exact `onboarding_id` plus `smoke_tag`, an intent key, and a deterministic Google Calendar event ID.
3. Reads all `Bookings` rows in that stable parent scope. An exact confirmed replay is a no-op. Any first changed UID, slot, or payload is persisted as `reschedule_required` and stops before Calendar; a replay of that review stays a no-op.
4. Inserts `intent_written` and requires an acknowledged matching row before checking Calendar availability.
5. On an available slot, creates a native Google Calendar event with the deterministic ID, validates the create result, gets the event by ID, and validates the readback.
6. Updates the Booking to `confirmed` only after non-cancelled provider evidence contains the expected event ID and matching parseable start and end. It requires a durable confirmation acknowledgement before creating a Gmail draft.
7. Runs a scheduled get-only reconciliation lane for unresolved intent rows. It adopts exact provider success after a database-acknowledgement failure; missing, duplicate, unsafe, cancelled, or mismatched state becomes `needs_review`. Reconciliation never creates an event.

## Outcomes

| Outcome | Meaning | Provider behavior |
|---|---|---|
| `unauthorized` | Token missing or wrong (`401`) | No state or provider node is reachable |
| `malformed` | Contract, civil timestamp, timezone, offset, owner, or tag is invalid (`400`) | No state or provider node is reachable |
| `replay` / `confirmed` | One exact confirmed Booking with valid stored evidence (`200`) | No new availability, create, get, or draft |
| `replay` / `needs_review` | Existing exact request is unresolved or ambiguous (`200`) | No provider retry |
| `human_review` / `reschedule_required` | Stable parent scope already has a different booking request (`202`) | No Calendar lookup or mutation |
| `busy` / `needs_review` | Intent was acknowledged but the slot is unavailable (`409`) | Availability only; no create |
| `confirmed` | Provider create and get evidence match and the Booking update is acknowledged (`200`) | Gmail draft is attempted afterward; never sent |

Production-intake Data Table writes plus Calendar availability, create, and created-event get fail-stop. Gmail draft creation is best effort and continues to the confirmed response; a missing or errored reconciliation get becomes `needs_review`. The workflow does not return a false success response for an unacknowledged intent, an invalid provider result, or an unacknowledged confirmation.

## Bookings table

Create one n8n Data Table named `Bookings`, then re-select it in every Data Table node. The insert/update mappings define these columns:

- Identity and scope: `booking_uid`, `onboarding_id`, `smoke_tag`, `scope_key`, `intent_key`
- Request evidence: `request_bytes`, `request_hash`, `verified_email`, `slot_start_utc`, `slot_end_utc`, `slot_tz`
- Lifecycle: `status`, `review_reason`, `created_at_utc`, `updated_at_utc`, `last_execution_id`
- Provider evidence: `provider_event_id`, `provider_event_status`, `provider_event_start_utc`, `provider_event_end_utc`, `provider_evidence_json`

The result contract consumed by workflow 08 is preserved: exact `booking_uid`, `onboarding_id`, and `smoke_tag`, `status=confirmed`, and the requested instant in `slot_start_utc`.

## Setup

1. Import `workflow.json` and keep it inactive.
2. Create and select the `Bookings` Data Table described above.
3. Create n8n variables `BOOKING_INTAKE_TOKEN` and `BOOKING_CALENDAR_ID`. Variables require an n8n plan that supports `$vars`; otherwise replace them with an equivalent server-side secret/configuration mechanism before activation.
4. Attach a Google Calendar credential to all four native Calendar nodes: availability, create, created-event get, and reconciliation get.
5. Attach a Gmail credential to `Create Confirmation Draft`. The node uses `resource=draft`, `operation=create`; there is no Gmail send node.
6. Review the private event summary/description, reminders, target calendar, 30-minute reconciliation cadence, and customer-facing draft text.
7. Exercise every local fixture and a tagged test-webhook request while inactive. Inspect Data Table rows and Calendar test data before considering activation.

## Safe manual fixtures

The isolated fixture component is:

`Booking Fixture Manual Trigger` → `Select Fixture Scenario` → `Route Booking Fixture` → one terminal fixture assertion.

Edit the single local `selectedScenario` constant in `Select Fixture Scenario` to one of:

- `available`
- `busy`
- `replay`
- `invalid-timezone`
- `failed-before-send`
- `provider-success/ack-failure`
- `changed-slot`

These ten nodes are structurally disconnected from every Data Table, Google Calendar, Gmail, webhook-response, and scheduled-reconcile node. They use only synthetic `example.test` data and local Code/Switch logic. They are evidence fixtures, not live integration tests.

## Residuals and limits

- n8n Data Tables do not provide an atomic compare-and-set lock across the read, intent insert, provider create, and confirmation update. Concurrent first deliveries can both observe no row. Deterministic provider identity limits the damage, but this is not exactly-once execution.
- Calendar create and the following Data Table acknowledgement are not transactional. If Calendar succeeds and the database acknowledgement fails, the scheduled lane can adopt the stored event by ID without another create. Duplicate or ambiguous intent rows are held for human review instead of queried or recreated.
- A provider conflict, missing event, cancelled event, unsafe stored ID, or time mismatch is never interpreted as permission to create again.
- Version 1 does not automatically reschedule, update, cancel, or delete Calendar events. Changed requests are human-review work.
- Gmail draft evidence is deliberately not part of Booking success. A draft failure leaves the acknowledged Booking confirmed, and the workflow does not send or automatically retry customer mail.
- Availability can change between the availability query and event creation. Review provider and calendar conflict handling for the target calendar's operational rules.
- Scheduled reconciliation reads unresolved intent rows at SME scale. For large tables, add an indexed/partitioned adapter without weakening exact owner/tag and request matching.
- The template does not claim attendance, no-show detection, reminder delivery, or exactly-once semantics.
