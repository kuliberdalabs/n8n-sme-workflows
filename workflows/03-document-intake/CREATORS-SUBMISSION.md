# n8n Creators submission — Document Intake

## Upload

`workflow-annotated-v2.json`

SHA-256: `9a59b009017ef8d1b4e2540d883a841a1fec54674b9bc54777dfc5bce2f26622`

## Title

Classify inbound documents and route uncertain cases with OpenAI, Gmail, and Data Tables

## Short description

Classify authenticated OCR document payloads with OpenAI, validate every result, store deterministic filing records in n8n Data Tables, and route uncertain cases to a Gmail review queue.

## Categories

1. Invoice Processing
2. AI Summarization

## Description

# Classify inbound documents and route uncertain cases for human review

This workflow helps small back-office teams process OCR-ready scans and PDFs without trusting an AI result by default. It accepts an authenticated document payload, rejects malformed or duplicate requests, checks OCR quality, and sends only a redacted text excerpt and sanitized filename to OpenAI.

The model classifies the document as Invoice, Contract, Receipt, or Other and extracts a small typed set of fields. A strict validation step checks the schema, closed enums, duplicate JSON keys, confidence values, amount and currency rules, and the model's explicit review decision. Only a fully valid, high-confidence result becomes a logical Filed record. Everything else goes to Needs Review and alerts a fixed operator inbox through Gmail.

The workflow records all outcomes in an n8n Data Table. An hourly reconciliation branch retries review alerts that have not been confirmed as sent. Duplicate intake requests return the existing result instead of repeating the main processing path.

## How it works

1. Receives a document payload through a token-protected webhook.
2. Validates the filename, MIME type, OCR text, file identity, and optional scope fields.
3. Builds a deterministic document key and checks the Data Table for a prior result.
4. Routes malformed input to a dead-letter record and weak OCR directly to human review.
5. Redacts sensitive patterns before OpenAI classifies usable OCR text and extracts fields.
6. Validates the complete AI response and records either Filed or Needs Review.
7. Sends review alerts to a fixed Gmail inbox and retries only alerts still marked unsent.

## Setup

1. Create an n8n Data Table named `Intake_Documents`, include optional string columns `onboarding_id` and `smoke_tag`, and re-select the table in every Data Table node. Use the field names shown in the four insert nodes for the remaining columns.
2. Create the `DOC_INTAKE_WEBHOOK_TOKEN` n8n Variable.
3. Connect an OpenAI credential to `Extract Document Fields`.
4. Connect Gmail credentials to all three review-alert nodes.
5. Replace every `ops@example.com` value with a controlled review inbox.
6. Keep the workflow inactive while testing. Send a sample request to the test webhook with the `x-doc-intake-token` header, then test weak OCR, malformed input, an uncertain classification, and a duplicate replay before activation.

## Good to know

- The workflow expects OCR text in the webhook payload. It does not watch a mailbox, run OCR, or accept a binary file by itself.
- Filing is logical only: the Filed row contains an `archive_path`; the workflow does not move a file to Drive, SharePoint, or S3.
- The redacted OCR excerpt is sent to OpenAI. Review that data flow against your privacy and processing requirements before using real documents.
- n8n Variables require a plan that supports `$vars`. If unavailable, replace the token source with another server-side secret mechanism.
- The in-workflow duplicate claim is a best-effort replay guard, not an atomic lock for simultaneous requests.
- Gmail delivery and the following Data Table update are not transactional, so a later reconciliation run can resend an alert if Gmail succeeded but the update failed.

## Submission checklist

- [ ] Upload `workflow-annotated-v2.json`, not `workflow.json` and not the QA fresh export.
- [ ] Verify the upload hash is `9a59b009017ef8d1b4e2540d883a841a1fec54674b9bc54777dfc5bce2f26622`.
- [ ] Confirm the canvas shows one yellow overview and seven white section backgrounds.
- [ ] Keep the workflow inactive during reviewer setup and testing.
- [ ] Select OpenAI, Gmail, and Data Tables as integrations if the portal asks for them.
- [ ] Do not add a GitHub URL unless the form explicitly requires one.
