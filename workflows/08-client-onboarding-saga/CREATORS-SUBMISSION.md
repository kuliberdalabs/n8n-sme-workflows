# n8n Creators submission — Client Onboarding Saga

## Upload

`workflow-annotated-v2.json`

SHA-256: `16a887e893b5d56d316e7989cb3b1d10f40c3bcf6ee7b3075b8f21d430be0efc`

## Title

Coordinate client onboarding with durable saga state, Gmail, and Data Tables

## Short description

Track offer, invoice, kickoff, signed-document, welcome, and checklist steps in one durable onboarding saga, adopt late evidence safely, and alert stalled cases through Gmail.

## Categories

1. CRM
2. Project Management

## Description

# Coordinate multi-step client onboarding without duplicate work

This workflow helps service businesses track a client onboarding case across several teams and systems. A token-protected webhook creates or joins one durable onboarding saga, then records six steps: offer, first invoice, kickoff booking, signed document, welcome-email record, and internal-checklist record.

The workflow is deliberately evidence-driven. It writes step intents before work is attributed to a case and marks external steps complete only when their own result tables contain matching evidence. Duplicate deliveries join the existing saga instead of recreating finished steps. Ambiguous, conflicting, or incorrectly scoped evidence fails closed for human review rather than authorizing another external side effect.

A scheduled reconciliation branch rechecks late results every 30 minutes, repairs stale parent state, respects cancellations, and sends throttled Gmail alerts for stalled cases. The parent workflow coordinates state; it does not invoke the offer, invoice, booking, or document workflows itself.

## How it works

1. Receives a client-onboarding payload through a token-protected webhook.
2. Validates the stable client or deal identity, verified email, service code, kickoff slot, and optional document fields.
3. Creates or joins a deterministic onboarding saga in n8n Data Tables.
4. Writes only the missing step intents for offer, invoice, kickoff, document, welcome, and checklist work.
5. Reads each external step's own result table and accepts only evidence with the exact onboarding owner and run scope.
6. Rolls the step results into a durable parent state such as Complete, Human Required, Partial Blocked, or Unknown Child Result.
7. Reconciles late evidence every 30 minutes, repairs stale state, and sends throttled Gmail alerts for stalled cases.

## Setup

1. Create Data Tables named `Onboardings`, `Onboarding_Steps`, `Onboarding_Reconcile_Alerts`, `Quote_Offers`, `Dunning_Invoices`, `Bookings`, and `Intake_Documents`. Add the columns mapped by the corresponding Data Table nodes, including string columns `onboarding_id` and `smoke_tag` in every external result table, then re-select your table in each node.
2. Create the `ONBOARDING_INTAKE_TOKEN` n8n Variable. The optional variables documented in the yellow overview can pin the operational scope and child-workflow versions.
3. Connect a Gmail credential to `Send Controlled Reconcile Alert`.
4. Replace `ops@example.com` with a controlled operations inbox.
5. Connect separate offer, invoice, booking, and document workflows or adapters so they consume the intent rows and write exact-key evidence to their result tables.
6. Keep the workflow inactive while testing. Send a valid request to the test webhook, inspect the claim and step rows, then replay the identical request and confirm that no duplicate rows or sends are produced.

## Good to know

- This workflow coordinates state but does not invoke the four external step workflows. Without compatible consumers, their steps remain honestly unresolved.
- The welcome-email and internal-checklist steps are records only; this template does not send the welcome email or populate a checklist.
- n8n Variables require a plan that supports `$vars`. If unavailable, replace the token source with another server-side secret mechanism.
- Reconciliation reads complete Data Tables and filters in code, which is suitable for SME volumes but can become a bottleneck with tens of thousands of rows.
- Post-start corrections such as credit notes and booking changes route to human review. The workflow does not implement automatic compensation.
- First-delivery claiming is a read-back guard rather than an atomic database lock, so truly simultaneous first requests can still race.
- A Gmail send and the following Data Table acknowledgement are not transactional. A process failure in that narrow window can cause a later reconciliation run to resend the same alert.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json` and not the QA fresh export.
- [ ] Verify the upload hash is `16a887e893b5d56d316e7989cb3b1d10f40c3bcf6ee7b3075b8f21d430be0efc`.
- [ ] Confirm the canvas shows one yellow overview and nine white section backgrounds.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select Gmail and Data Tables as integrations if the portal asks for them.
- [ ] Use `CRM` and `Project Management` as the categories.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
