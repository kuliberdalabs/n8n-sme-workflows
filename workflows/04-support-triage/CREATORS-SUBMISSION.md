# n8n Creators submission — Support Triage

## Upload

`workflow-annotated-v2.json`

## Title

Triage support requests and prepare grounded replies with OpenAI and Gmail

## Short description

Triage webhook support requests against a closed knowledge base, draft only grounded OpenAI replies, and require a separate human approval action before Gmail sends anything.

## Categories

1. Ticket Management
2. AI Chatbot

## Description

# Triage support requests with grounded AI drafts and human approval

This workflow helps small support teams turn repeated questions into reviewable, knowledge-base-grounded reply drafts without allowing the model to answer from its own knowledge or send directly from the intake path.

An intake webhook authenticates the request, normalizes and redacts sensitive patterns, and matches the question against a closed knowledge base. Questions without a reliable match go to a human without calling OpenAI. Matched questions are sent to OpenAI with only the selected knowledge-base entry, and the returned draft must pass source, intent, confidence, and unsafe-phrasing checks.

Every accepted draft is stored in an n8n Data Table and sent to the operator for review. A separate token-protected approval webhook handles approve, edit, reject, and escalate actions. Only approve or edit can reach the Gmail send node. Duplicate intake and approval events return the existing result instead of repeating the side effect.

## How it works

1. Receives a support request through a token-protected webhook.
2. Redacts sensitive patterns and matches the question against a reviewed inline knowledge base.
3. Escalates knowledge-base misses and failed model validations to a human.
4. Stores validated OpenAI replies as drafts and alerts the operator.
5. Sends only after a separate approve or edit action; reject and escalate never send.
6. Retries unconfirmed operator alerts without changing the current ticket decision.

## Setup

1. Create the `Support_Tickets` and `Support_KB_Learnings` n8n Data Tables, then re-select them in every Data Table node.
2. Create separate `SUPPORT_INTAKE_TOKEN` and `SUPPORT_APPROVAL_TOKEN` n8n Variables.
3. Connect OpenAI and Gmail credentials.
4. Replace every `ops@example.com` value with a controlled review inbox.
5. Replace the four demo knowledge-base entries in `Normalize Support Intake` with reviewed content for your business.
6. Test a knowledge-base miss, duplicate request, injection-style message, approval, edit, rejection, and alert retry while the workflow is inactive.

## Good to know

- The published template is safe by default: every Gmail node targets a fixed operator inbox, not an address supplied by the webhook or the model.
- To send approved replies to real customers, deliberately replace the controlled-recipient design only after adding your own trusted customer-identity lookup and tests.
- n8n Variables require a plan that supports `$vars`. If unavailable, replace the token source with another server-side secret mechanism.
- The included knowledge base is a four-entry demo. Production use needs an owner and a review process for knowledge changes.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json`.
- [ ] Confirm the canvas shows one yellow overview and ten white section backgrounds.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select the OpenAI and Gmail app tags if the portal asks for integrations.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
