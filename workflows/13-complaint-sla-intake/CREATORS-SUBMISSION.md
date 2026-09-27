# Creator submission copy

## Title
Track complaint ownership and response deadlines with webhooks, Gmail and Data Tables

## Description

Give every complaint an owner, track an explicit response deadline, and alert your internal team when ownership or a response needs attention. This template is for a service desk or operations team that already keeps the original complaint in a source system and wants a lightweight, durable follow-up workflow in n8n.

### How it works

An authenticated webhook accepts only bounded complaint metadata. A stable tenant/source identity detects sequential duplicates and conflicting retries. The case is persisted before the webhook confirms success.

A scheduled sweep checks cases every 15 minutes. Unacknowledged ownership escalates from owner to lead to manager. A separate response-deadline clock alerts within 72 hours, within 24 hours, at breach and daily afterward. Acknowledging ownership does not stop response-deadline alerts. The currently assigned role can close the case through a separate authenticated webhook with a resolution reference.

Internal Gmail alerts have durable intent and provider-result records. Missing or uncertain delivery evidence requires reconciliation instead of an automatic resend. The workflow uses native n8n nodes and deterministic logic; no AI model is required.

### Who it is for

Teams receiving complaints through an existing form, CRM, helpdesk or other trusted source that can supply case references and an explicitly reviewed response deadline. It is suitable for one trusted operations lane with three configurable owner roles.

### Setup

1. Import the template inactive. Confirm UTC, execution logic v1, and Do not save for failed, successful and manual executions in Workflow settings: editor imports may retain destination settings. Create the two Data Tables using the exact schemas in the repository README.
2. Re-select the case and alert table in every Data Table node.
3. Configure an intake token, distinct tokens for the three owner roles, and the three internal email addresses in n8n Variables.
4. Connect Gmail OAuth and keep all alert recipients internal.
5. Configure the ownership SLA interval and send synthetic metadata with explicit timestamp offsets.
6. Test intake, duplicate delivery, acknowledgement, an overdue acknowledged case, closure and uncertain delivery handling before activation.

### Requirements and boundaries

You need n8n Variables, Data Tables, Gmail OAuth and a trusted source-system caller. For self-hosting, Code nodes require the crypto built-in. Original complaint text, customer addresses and attachments stay in your source system. The workflow creates no automatic customer reply, refund or legal decision.

The response deadline is supplied with a policy reference. This template does not determine legal applicability or calculate statutory periods. Missing deadlines are routed for review. Data Tables provide sequential replay suppression rather than transactional exactly-once processing; serialize this lane or replace storage before concurrent production use. Failed or uncertain delivery must be reconciled manually.

### Customization

Change internal recipients, ownership SLA hours and sweep frequency. Connect your existing complaint source and reviewed deadline policy. Full schemas, request examples, owner actions and recovery instructions are in the repository README.

Source: https://github.com/kuliberdalabs/n8n-sme-workflows

## Suggested category
Customer Support

## Additional category, if available
IT Ops

## Pricing
Free

## Exact upload artifact
`workflow-annotated-v2.json` beside this file. The dated QA receipt owns its exact SHA-256 and readiness gate. This copy does not establish portal submission or approval.
