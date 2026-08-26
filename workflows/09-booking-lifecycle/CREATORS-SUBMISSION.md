# n8n Creators submission — Booking Lifecycle

## Upload

`workflow-annotated-v2.json`

SHA-256: `854f0009951a285b0bbe326d83c4005cf71c8bfb092b3af9354ac10a5a332873`

## Title

Create replay-safe client kickoff bookings with Google Calendar, Gmail, and n8n Data Tables

## Short description

Create kickoff events only after durable intent, confirm them from Google Calendar readback, hold changed requests for review, and prepare customer communication as Gmail drafts.

## Categories

1. Sales
2. Productivity

## Description

# Create kickoff bookings without silently duplicating changed requests

This workflow turns a verified onboarding booking request into a durable kickoff reservation. A token-protected webhook validates the exact owner, run tag, client email, explicit-offset slot, and IANA timezone before any state or provider node can run. It is compatible with the `kickoff_booking` request and `Bookings` result used by the Client Onboarding Saga in workflow 08.

The workflow reads all prior Booking rows in the stable onboarding owner and run scope. An exact confirmed replay returns stored evidence without another provider call. A changed slot also changes workflow 08's booking UID, so this template deliberately detects that change at the stable parent scope and writes `reschedule_required` for human review without checking or mutating Calendar.

For a new booking, the workflow persists and verifies intent before using native Google Calendar availability. An available slot proceeds through Calendar event creation and a get-by-ID readback. Only a matching, non-cancelled event ID with matching parseable times may become a durably acknowledged `confirmed` Booking. Gmail then attempts to create a customer draft; the workflow never sends it, and draft creation is not required for Booking success.

A scheduled reconciliation branch handles the narrow provider-success/database-acknowledgement gap by getting the stored Calendar event ID and adopting exact success. It never calls availability or create. Missing, duplicated, unsafe, cancelled, or mismatched provider state goes to human review.

## How it works

1. Authenticates the POST webhook with the server-side `BOOKING_INTAKE_TOKEN`.
2. Validates the seven-field booking contract, real civil dates, offset/timezone agreement, and workflow 08 booking-UID derivation.
3. Derives deterministic request, parent-scope, intent, and provider identity evidence.
4. Reads stable owner/tag history and returns replays or records changed requests before any Calendar operation.
5. Persists and acknowledges `intent_written`, then checks native Google Calendar availability.
6. Creates the event, validates the create result, gets it by ID, and validates the provider readback.
7. Persists and acknowledges the `confirmed` Booking, then attempts to create a Gmail draft without sending it.
8. Reconciles unresolved intents with a get-only provider lookup and no create or retry path.

## Setup

1. Create a `Bookings` Data Table with the columns mapped in the insert and update nodes, then re-select it in every Data Table node.
2. Create n8n variables `BOOKING_INTAKE_TOKEN` and `BOOKING_CALENDAR_ID`.
3. Connect a Google Calendar credential to the availability, create, created-event get, and reconciliation get nodes.
4. Connect a Gmail credential to `Create Confirmation Draft`.
5. Review the private event details, reminders, target calendar, reconciliation cadence, and draft copy.
6. Keep the workflow inactive while testing. Use each built-in manual fixture, then send a synthetic tagged request to the test webhook and inspect the resulting test Calendar event and Booking row.

## Good to know

- The seven manual scenarios are a separate local Code/Switch component. They are structurally disconnected from Data Tables, Google Calendar, Gmail, and the production webhook path.
- Gmail creates drafts only. This template contains no Gmail send operation.
- Data Table reads and writes fail-stop. Provider success is accepted only after matching Calendar create and get evidence and a durable Booking acknowledgement.
- n8n Data Tables do not provide an atomic lock across read, insert, provider create, and update. Deterministic provider identity and get-only reconciliation reduce duplicate risk, but the workflow does not claim exactly-once execution.
- Calendar create and the following database acknowledgement are not transactional. The reconciler adopts an exact stored event after that narrow failure window; ambiguous state is held and never authorizes another create.
- Version 1 does not automatically reschedule, update, cancel, or delete an event. It does not track attendance or no-shows.
- Availability can change between checking and creating. Adapt conflict handling to the target calendar's operating rules.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json`.
- [ ] Verify the upload hash is `854f0009951a285b0bbe326d83c4005cf71c8bfb092b3af9354ac10a5a332873`.
- [ ] Confirm the canvas shows one yellow overview and seven white section backgrounds.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select Google Calendar, Gmail, and n8n Data Tables as integrations if the portal asks for them.
- [ ] Use `Sales` and `Productivity` as the categories.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
