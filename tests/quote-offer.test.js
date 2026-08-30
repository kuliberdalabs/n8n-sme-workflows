'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const { executeCodeNode, loadWorkflow, workflowFile } = require('./helpers/workflow-vm');

const quoteWorkflow = workflowFile('11-quote-offer');
const annotatedWorkflow = quoteWorkflow.replace('workflow.json', 'workflow-annotated-v2.json');
const onboardingWorkflow = workflowFile('08-client-onboarding-saga');

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function body(overrides = {}) {
  return {
    onboarding_id: 'a'.repeat(64),
    smoke_tag: 'ONBOARDING-DRAFT',
    client_name: 'Ada Example',
    company: 'Example Company',
    email: 'ada@example.test',
    verified_email: 'ada@example.test',
    service_code: 'workflow_build',
    quantity: 1,
    request_details: 'Build and hand over one production workflow.',
    request_text: 'Build and hand over one production workflow.',
    ...overrides,
  };
}

function normalize(overrides = {}) {
  return executeCodeNode(quoteWorkflow, 'Normalize Quote Request', {
    input: { body: body(overrides) },
  }).json;
}

function resolve(normalized, rows = []) {
  return executeCodeNode(quoteWorkflow, 'Resolve Quote Intake', {
    inputRows: rows,
    nodeItems: { 'Normalize Quote Request': [normalized] },
  }).json;
}

function approval(overrides = {}) {
  return executeCodeNode(quoteWorkflow, 'Normalize Quote Approval', {
    input: {
      body: {
        submission_id: normalize().submission_id,
        onboarding_id: 'a'.repeat(64),
        smoke_tag: 'ONBOARDING-DRAFT',
        action: 'approve',
        approval_actor: 'ops-reviewer',
        approval_note: 'Scope confirmed.',
        approval_event_id: 'approval-event-1042',
        approval_event_at_utc: '2026-09-02T10:00:00Z',
        ...overrides,
      },
    },
  }).json;
}

function resolveApproval(normalizedApproval, rows = []) {
  return executeCodeNode(quoteWorkflow, 'Resolve Quote Approval', {
    inputRows: rows,
    nodeItems: { 'Normalize Quote Approval': [normalizedApproval] },
  }).json;
}

function nodeByName(workflow, name) {
  const matches = workflow.nodes.filter((node) => node.name === name);
  assert.equal(matches.length, 1, `expected exactly one ${name}`);
  return matches[0];
}

function direct(workflow, name, branch = 0) {
  return (workflow.connections[name]?.main?.[branch] || []).map((edge) => edge.node);
}

function reachable(workflow, start) {
  const seen = new Set();
  const pending = [start];
  while (pending.length) {
    const name = pending.pop();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    for (const branch of workflow.connections[name]?.main || []) {
      for (const edge of branch || []) pending.push(edge.node);
    }
  }
  return seen;
}

function reviewRow(overrides = {}) {
  const n = normalize({ request_details: 'Please include custom legal terms.', request_text: 'Please include custom legal terms.' });
  const row = resolve(n);
  assert.equal(row.action, 'new_review');
  return { ...row, ...overrides };
}

test('intake and approval tokens are separate, fail closed, and accept only their own configured lane', () => {
  const missingIntake = executeCodeNode(quoteWorkflow, 'Validate Quote Intake Token', {
    input: { headers: { 'x-quote-approval-token': 'approval-secret' }, body: {} },
    vars: {},
  }).json;
  assert.equal(missingIntake.auth_ok, false);
  assert.equal(missingIntake.auth_reason, 'missing_server_token_var_QUOTE_INTAKE_TOKEN');

  const wrongLane = executeCodeNode(quoteWorkflow, 'Validate Quote Intake Token', {
    input: { headers: { 'x-quote-approval-token': 'intake-secret' }, body: {} },
    vars: { QUOTE_INTAKE_TOKEN: 'intake-secret' },
  }).json;
  assert.equal(wrongLane.auth_ok, false);

  const intakeOk = executeCodeNode(quoteWorkflow, 'Validate Quote Intake Token', {
    input: { headers: { authorization: 'Bearer intake-secret' }, body: {} },
    vars: { QUOTE_INTAKE_TOKEN: 'intake-secret' },
  }).json;
  assert.equal(intakeOk.auth_ok, true);
  assert.equal(Object.hasOwn(intakeOk.headers, 'authorization'), false);

  const approvalMissing = executeCodeNode(quoteWorkflow, 'Validate Quote Approval Token', {
    input: { headers: { 'x-quote-intake-token': 'approval-secret' }, body: {} },
    vars: { QUOTE_APPROVAL_TOKEN: 'approval-secret' },
  }).json;
  assert.equal(approvalMissing.auth_ok, false);

  const approvalOk = executeCodeNode(quoteWorkflow, 'Validate Quote Approval Token', {
    input: { headers: { 'x-quote-approval-token': 'approval-secret' }, body: {} },
    vars: { QUOTE_APPROVAL_TOKEN: 'approval-secret' },
  }).json;
  assert.equal(approvalOk.auth_ok, true);
  assert.equal(Object.hasOwn(approvalOk.headers, 'x-quote-approval-token'), false);
});

test('fixed price book supports all workflow 08 service codes with integer minor units and explicit bounds', () => {
  const fixtures = [
    ['ai_audit', 1, 180000],
    ['automation_retainer', 6, 900000],
    ['workflow_build', 3, 960000],
    ['ops_sprint', 2, 960000],
  ];
  for (const [service_code, quantity, expectedTotal] of fixtures) {
    const n = normalize({ service_code, quantity });
    assert.equal(n.valid_input, true, `${service_code}:${n.validation_errors}`);
    assert.equal(n.total_net_minor, expectedTotal);
    assert.equal(Number.isSafeInteger(n.unit_net_minor), true);
    assert.equal(Number.isSafeInteger(n.total_net_minor), true);
    assert.equal(n.price_book_version, 'QUOTE_SAMPLE_V1_2026-08-30');
    assert.equal(n.currency, 'USD');
  }
  for (const [service_code, quantity] of [['ai_audit', 2], ['automation_retainer', 7], ['workflow_build', 4], ['ops_sprint', 3]]) {
    const n = normalize({ service_code, quantity });
    assert.equal(n.valid_input, false);
    assert.ok(n.validation_errors.includes('quantity_outside_price_book_bounds'));
  }
});

test('workflow 08 child payload produces the exact parent-compatible submission id and preserves owner and smoke scope', () => {
  const onboarding = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: {
      body: {
        deal_id: 'quote-child-contract-001',
        client_external_id: 'client-quote-001',
        client_name: 'Ada Example',
        company: 'Example Company',
        verified_email: 'ada@example.test',
        service_code: 'workflow_build',
        quantity: 1,
        request_details: 'Build and hand over one production workflow.',
        kickoff_slot_start: '2026-09-01T09:00:00Z',
        kickoff_slot_end: '2026-09-01T10:00:00Z',
        kickoff_slot_tz: 'UTC',
        filename: 'agreement.pdf',
        mime_type: 'application/pdf',
        attachment_id: 'attachment-quote-001',
        ocr_text: 'Synthetic signed agreement text. '.repeat(12),
        ocr_confidence: 0.99,
        scan_text_ratio: 0.99,
      },
    },
    vars: { ONBOARDING_SMOKE_TAG: 'ONBOARDING-DRAFT' },
  }).json;
  assert.equal(onboarding.ok, true, JSON.stringify(onboarding.errors));
  const offerStep = JSON.parse(onboarding.planned_steps_json).find((step) => step.step_name === 'offer_out');
  assert.ok(offerStep);
  const request = JSON.parse(offerStep.request_snapshot_bytes);
  const n = executeCodeNode(quoteWorkflow, 'Normalize Quote Request', { input: { body: request } }).json;
  const expected = hash([
    request.onboarding_id, request.email, request.service_code, request.quantity, request.request_details,
  ].join('\n').toLowerCase());
  assert.equal(n.valid_input, true, JSON.stringify(n.validation_errors));
  assert.equal(n.submission_id, expected);
  assert.equal(n.submission_id, offerStep.predicted_child_key);
  assert.equal(n.offer_submission_id, expected);
  assert.equal(n.onboarding_id, request.onboarding_id);
  assert.equal(n.smoke_tag, request.smoke_tag);
});

test('full request fingerprint covers every non-parent field that changes output or review routing', () => {
  const base = normalize();
  for (const overrides of [
    { client_name: 'Grace Example' },
    { company: 'Changed Company' },
    { verified_email: 'review@example.test' },
    { smoke_tag: 'SECOND-RUN' },
  ]) {
    const changed = normalize(overrides);
    if (overrides.smoke_tag) assert.notEqual(changed.quote_key, base.quote_key);
    else assert.equal(changed.submission_id, base.submission_id);
    assert.notEqual(changed.request_fingerprint, base.request_fingerprint);
  }
  assert.equal(base.request_fingerprint, normalize().request_fingerprint);
});

test('only whitelisted bounded fields survive normalization and caller controls cannot force price, recipient, or review', () => {
  const n = normalize({
    send_to: 'attacker@example.test', recipient: 'attacker@example.test', discount: 99,
    client_type: 'vip', force_review: true, role: 'admin', price: 1,
  });
  assert.equal(n.valid_input, true);
  assert.equal(n.needs_review, false);
  assert.equal(n.total_net_minor, 320000);
  for (const field of ['send_to','recipient','discount','client_type','force_review','role','price','raw_body','raw_request_json']) {
    assert.equal(Object.hasOwn(n, field), false, field);
  }

  const mismatched = normalize({ verified_email: 'other@example.test' });
  assert.equal(mismatched.valid_input, true);
  assert.equal(mismatched.recipient_verified, false);
  assert.equal(mismatched.needs_review, true);
  assert.match(mismatched.review_reason, /mismatch/);
});

test('one-object contract rejects batch shapes, object strings, malformed scope, and unsafe quantities', () => {
  for (const invalidBody of [null, [], 'string']) {
    const n = executeCodeNode(quoteWorkflow, 'Normalize Quote Request', { input: { body: invalidBody } }).json;
    assert.equal(n.valid_input, false);
    assert.ok(n.validation_errors.includes('request_body_must_be_one_object'));
  }
  const batches = executeCodeNode(quoteWorkflow, 'Normalize Quote Request', {
    input: { body: { ...body(), requests: [body()] } },
  }).json;
  assert.equal(batches.valid_input, false);
  assert.ok(batches.validation_errors.includes('batch_payload_not_supported'));

  for (const overrides of [
    { client_name: { value: 'Ada' } },
    { onboarding_id: 'A'.repeat(64) },
    { smoke_tag: ' PADDED ' },
    { quantity: 1.5 },
    { quantity: Infinity },
    { quantity: 'NaN' },
  ]) assert.equal(normalize(overrides).valid_input, false, JSON.stringify(overrides));

  const unknownService = normalize({ service_code: 'unknown_service' });
  assert.equal(unknownService.valid_input, true);
  assert.equal(unknownService.needs_review, true);
  assert.equal(unknownService.has_price_book_entry, false);
  assert.equal(unknownService.total_net_minor, 0);
  assert.match(unknownService.review_reason, /price book entry required/);
});

test('offer HTML escapes bounded client text and never renders raw active markup', () => {
  const n = normalize({
    client_name: '<img src=x onerror=alert(1)>',
    company: '<script>alert(1)</script>',
    request_details: 'Build <svg onload=alert(1)> workflow.',
    request_text: 'Build <svg onload=alert(1)> workflow.',
  });
  assert.equal(n.valid_input, true);
  assert.doesNotMatch(n.offer_html, /<script|<img|<svg/i);
  assert.match(n.offer_html, /&lt;script&gt;/);
  assert.match(n.offer_html, /&lt;img/);
  assert.match(n.offer_html, /&lt;svg/);
});

test('intake durable resolution creates once, replays without writes, and holds changed identity', () => {
  const n = normalize();
  const first = resolve(n);
  assert.equal(first.action, 'new_standard');
  assert.equal(first.lifecycle_state, 'Standard Send Pending');
  assert.equal(first.email_sent, false);

  const replay = resolve(n, [first]);
  assert.equal(replay.action, 'terminal');
  assert.equal(replay.terminal_status, 'duplicate_replay');
  assert.equal(replay.response_code, 200);

  const changed = normalize({ company: 'Changed Company' });
  assert.equal(changed.submission_id, n.submission_id);
  const conflict = resolve(changed, [first]);
  assert.equal(conflict.action, 'terminal');
  assert.equal(conflict.terminal_status, 'submission_identity_conflict');
  assert.equal(conflict.response_code, 409);

  for (const terminal of [replay, conflict]) {
    assert.equal(executeCodeNode(quoteWorkflow, 'Filter New Standard Quote', { input: terminal }).length, 0);
    assert.equal(executeCodeNode(quoteWorkflow, 'Filter New Review Quote', { input: terminal }).length, 0);
    assert.equal(executeCodeNode(quoteWorkflow, 'Filter Quote Terminal Outcome', { input: terminal }).length, 1);
  }
});

test('ambiguous physical rows fail closed independent of row order and are never silently pick-first', () => {
  const n = normalize();
  const first = resolve(n);
  const second = { ...first, lifecycle_state: 'Offer Sent', email_sent: true };
  for (const rows of [[first, second], [second, first], [first, { ...first }]]) {
    const result = resolve(n, rows);
    assert.equal(result.action, 'terminal');
    assert.equal(result.terminal_status, 'ambiguous_duplicate_scope');
    assert.equal(result.match_count, 2);
    assert.equal(executeCodeNode(quoteWorkflow, 'Filter New Standard Quote', { input: result }).length, 0);
    assert.equal(executeCodeNode(quoteWorkflow, 'Filter New Review Quote', { input: result }).length, 0);
  }
});

test('review alert provider evidence is separate and can never mark a client offer sent', () => {
  const row = reviewRow();
  const missing = executeCodeNode(quoteWorkflow, 'Validate Review Alert Gmail Evidence', {
    input: { id: 'review-message-only' },
    nodeItems: { 'Verify Review Intent Acknowledgement': [row] },
  }).json;
  assert.equal(missing.status, 'Needs Review');
  assert.equal(missing.email_sent, false);
  assert.equal(missing.review_alert_sent, false);
  assert.match(missing.review_alert_send_error, /missing_gmail/);

  const success = executeCodeNode(quoteWorkflow, 'Validate Review Alert Gmail Evidence', {
    input: { id: 'review-message-1', threadId: 'review-thread-1' },
    nodeItems: { 'Verify Review Intent Acknowledgement': [row] },
  }).json;
  assert.equal(success.status, 'Needs Review');
  assert.equal(success.lifecycle_state, 'Needs Review');
  assert.equal(success.email_sent, false);
  assert.equal(success.review_alert_sent, true);
  assert.equal(success.review_alert_provider_message_id, 'review-message-1');
  assert.equal(success.review_alert_provider_thread_id, 'review-thread-1');
});

test('standard delivery becomes Offer Sent only with both Gmail message and thread identifiers', () => {
  const row = resolve(normalize());
  for (const provider of [
    {}, { id: 'message-only' }, { threadId: 'thread-only' }, { id: 'm', threadId: 't', error: 'provider_failed' },
  ]) {
    const result = executeCodeNode(quoteWorkflow, 'Validate Standard Gmail Evidence', {
      input: provider,
      nodeItems: { 'Verify Standard Intent Acknowledgement': [row] },
    }).json;
    assert.equal(result.provider_confirmed, false);
    assert.equal(result.status, 'Offer Pending Email');
    assert.equal(result.lifecycle_state, 'Standard Send Pending');
    assert.equal(result.email_sent, false);
  }
  const success = executeCodeNode(quoteWorkflow, 'Validate Standard Gmail Evidence', {
    input: { id: 'offer-message-1', threadId: 'offer-thread-1' },
    nodeItems: { 'Verify Standard Intent Acknowledgement': [row] },
  }).json;
  assert.equal(success.provider_confirmed, true);
  assert.equal(success.status, 'Offer Sent');
  assert.equal(success.lifecycle_state, 'Offer Sent');
  assert.equal(success.email_sent, true);
});

test('webhook success responses require the matching durable post-Gmail update acknowledgement', () => {
  const standardRow = resolve(normalize());
  const standardEvidence = executeCodeNode(quoteWorkflow, 'Validate Standard Gmail Evidence', {
    input: { id: 'standard-message-ack', threadId: 'standard-thread-ack' },
    nodeItems: { 'Verify Standard Intent Acknowledgement': [standardRow] },
  }).json;
  const standardResponse = executeCodeNode(quoteWorkflow, 'Build Standard Quote Response', {
    input: standardEvidence,
    nodeItems: { 'Validate Standard Gmail Evidence': [standardEvidence] },
  }).json;
  assert.equal(standardResponse.status, 'offer_sent');
  assert.equal(standardResponse.response_code, 201);
  assert.throws(() => executeCodeNode(quoteWorkflow, 'Build Standard Quote Response', {
    input: { ...standardEvidence, lifecycle_state: 'Standard Send Pending', email_sent: false },
    nodeItems: { 'Validate Standard Gmail Evidence': [standardEvidence] },
  }), /standard_delivery_update_not_acknowledged/);

  const review = reviewRow();
  const reviewEvidence = executeCodeNode(quoteWorkflow, 'Validate Review Alert Gmail Evidence', {
    input: { id: 'review-message-ack', threadId: 'review-thread-ack' },
    nodeItems: { 'Verify Review Intent Acknowledgement': [review] },
  }).json;
  const reviewResponse = executeCodeNode(quoteWorkflow, 'Build Review Quote Response', {
    input: reviewEvidence,
    nodeItems: { 'Validate Review Alert Gmail Evidence': [reviewEvidence] },
  }).json;
  assert.equal(reviewResponse.status, 'needs_review');
  assert.equal(reviewResponse.email_sent, false);
  assert.throws(() => executeCodeNode(quoteWorkflow, 'Build Review Quote Response', {
    input: { ...reviewEvidence, review_alert_provider_thread_id: '' },
    nodeItems: { 'Validate Review Alert Gmail Evidence': [reviewEvidence] },
  }), /review_alert_update_not_acknowledged/);

  const approvalRequest = approval({ submission_id: review.submission_id });
  const approved = resolveApproval(approvalRequest, [{ ...review, expires_at_utc: '2999-01-01T00:00:00.000Z' }]);
  const intent = executeCodeNode(quoteWorkflow, 'Build Approval Send Intent', { input: approved }).json;
  const approvedEvidence = executeCodeNode(quoteWorkflow, 'Validate Approved Gmail Evidence', {
    input: { id: 'approved-message-ack', threadId: 'approved-thread-ack' },
    nodeItems: { 'Verify Approval Send Intent': [intent] },
  }).json;
  const approvedResponse = executeCodeNode(quoteWorkflow, 'Build Approval Send Response', {
    input: approvedEvidence,
    nodeItems: { 'Validate Approved Gmail Evidence': [approvedEvidence] },
  }).json;
  assert.equal(approvedResponse.status, 'offer_sent');
  assert.throws(() => executeCodeNode(quoteWorkflow, 'Build Approval Send Response', {
    input: {},
    nodeItems: { 'Validate Approved Gmail Evidence': [approvedEvidence] },
  }), /approved_delivery_update_not_acknowledged/);
});

test('action and response acknowledgements reject zero or multiple physical update rows', () => {
  const fixtures = [
    ['Build Standard Quote Response', 'standard_delivery_ack_cardinality_violation'],
    ['Build Review Quote Response', 'review_alert_ack_cardinality_violation'],
    ['Build Approval Send Response', 'approved_delivery_ack_cardinality_violation'],
    ['Verify Rejection Acknowledgement', 'rejection_ack_cardinality_violation'],
    ['Verify Expiry Acknowledgement', 'expiry_ack_cardinality_violation'],
    ['Verify Approval Send Intent', 'approval_send_intent_ack_cardinality_violation'],
  ];
  for (const [name, marker] of fixtures) {
    assert.throws(() => executeCodeNode(quoteWorkflow, name, { inputRows: [] }), new RegExp(marker), `${name}:zero`);
    assert.throws(() => executeCodeNode(quoteWorkflow, name, { inputRows: [{}, {}] }), new RegExp(marker), `${name}:multiple`);
  }
});

test('approval normalization is bounded, explicit, and rejects malformed action, event, or scope', () => {
  const good = approval();
  assert.equal(good.valid_approval, true, JSON.stringify(good.validation_errors));
  assert.equal(good.approval_event_at_utc, '2026-09-02T10:00:00.000Z');
  for (const overrides of [
    { action: 'send' },
    { approval_actor: '' },
    { approval_event_id: '' },
    { approval_event_at_utc: '2026-09-02 10:00' },
    { onboarding_id: 'not-a-hash' },
    { smoke_tag: ' PADDED ' },
  ]) assert.equal(approval(overrides).valid_approval, false, JSON.stringify(overrides));
});

test('approval resolution handles approve, reject, expiry, replay, terminal, recipient, and ambiguous state without guessing', () => {
  const future = reviewRow({ expires_at_utc: '2999-01-01T00:00:00.000Z' });
  const a = approval({ submission_id: future.submission_id });
  assert.equal(resolveApproval(a, [future]).action, 'approval_send');
  assert.equal(resolveApproval(approval({ submission_id: future.submission_id, action: 'reject' }), [future]).action, 'approval_reject');
  assert.equal(resolveApproval(a, [{ ...future, expires_at_utc: '2020-01-01T00:00:00.000Z' }]).action, 'approval_expire');

  const replay = resolveApproval(a, [{ ...future, approval_event_id: a.approval_event_id, approval_event_fingerprint: a.approval_event_fingerprint }]);
  assert.equal(replay.action, 'approval_terminal');
  assert.equal(replay.terminal_status, 'approval_event_replay');

  const eventConflict = resolveApproval(a, [{ ...future, approval_event_id: a.approval_event_id, approval_event_fingerprint: 'different-event-fingerprint' }]);
  assert.equal(eventConflict.action, 'approval_terminal');
  assert.equal(eventConflict.terminal_status, 'approval_event_identity_conflict');
  assert.equal(eventConflict.response_code, 409);

  for (const [row, status] of [
    [{ ...future, lifecycle_state: 'Offer Sent' }, 'quote_offer_sent'],
    [{ ...future, lifecycle_state: 'Rejected' }, 'quote_rejected'],
    [{ ...future, lifecycle_state: 'Expired' }, 'quote_expired'],
    [{ ...future, lifecycle_state: 'Approval Send Pending' }, 'send_pending_reconciliation'],
    [{ ...future, recipient_verified: false, verified_email: 'other@example.test' }, 'verified_recipient_required'],
  ]) {
    const result = resolveApproval(a, [row]);
    assert.equal(result.action, 'approval_terminal');
    assert.equal(result.terminal_status, status);
  }

  const unknownPrice = reviewRow({ has_price_book_entry: false, expires_at_utc: '2999-01-01T00:00:00.000Z' });
  const unknownPriceApproval = approval({ submission_id: unknownPrice.submission_id });
  assert.equal(resolveApproval(unknownPriceApproval, [unknownPrice]).terminal_status, 'price_book_entry_required');

  assert.equal(resolveApproval(a, []).terminal_status, 'quote_not_found');
  for (const rows of [[future, { ...future }], [{ ...future }, future]]) {
    const result = resolveApproval(a, rows);
    assert.equal(result.terminal_status, 'ambiguous_duplicate_scope');
    assert.equal(result.match_count, 2);
    assert.equal(executeCodeNode(quoteWorkflow, 'Filter Approval Send', { input: result }).length, 0);
    assert.equal(executeCodeNode(quoteWorkflow, 'Filter Approval Rejection', { input: result }).length, 0);
  }
});

test('approve and reject persist actor, note, event, and time while client send remains provider-gated', () => {
  const review = reviewRow({ expires_at_utc: '2999-01-01T00:00:00.000Z' });
  const a = approval({ submission_id: review.submission_id });
  const row = resolveApproval(a, [review]);
  const intent = executeCodeNode(quoteWorkflow, 'Build Approval Send Intent', { input: row }).json;
  assert.equal(intent.lifecycle_state, 'Approval Send Pending');
  assert.equal(intent.email_sent, false);
  assert.equal(intent.approval_action, 'approve');
  assert.equal(intent.approval_actor, 'ops-reviewer');
  assert.equal(intent.approval_note, 'Scope confirmed.');
  assert.equal(intent.approval_event_id, 'approval-event-1042');
  assert.equal(intent.approval_event_at_utc, '2026-09-02T10:00:00.000Z');

  const failed = executeCodeNode(quoteWorkflow, 'Validate Approved Gmail Evidence', {
    input: { id: 'message-without-thread' },
    nodeItems: { 'Verify Approval Send Intent': [intent] },
  }).json;
  assert.equal(failed.status, 'Offer Pending Email');
  assert.equal(failed.lifecycle_state, 'Approval Send Pending');
  assert.equal(failed.email_sent, false);

  const sent = executeCodeNode(quoteWorkflow, 'Validate Approved Gmail Evidence', {
    input: { id: 'approved-message-1', threadId: 'approved-thread-1' },
    nodeItems: { 'Verify Approval Send Intent': [intent] },
  }).json;
  assert.equal(sent.status, 'Offer Sent');
  assert.equal(sent.email_sent, true);

  const rejection = executeCodeNode(quoteWorkflow, 'Build Quote Rejection Update', {
    input: resolveApproval(approval({ submission_id: review.submission_id, action: 'reject' }), [review]),
  }).json;
  assert.equal(rejection.status, 'Needs Review');
  assert.equal(rejection.lifecycle_state, 'Rejected');
  assert.equal(rejection.approval_action, 'reject');
  assert.equal(rejection.email_sent, false);
});

test('scheduled observability marks throttle only after confirmed Gmail and leaves failures retryable', () => {
  const old = '2020-01-01T00:00:00.000Z';
  const pending = {
    ...resolve(normalize()),
    created_at_utc: old,
    updated_at_utc: old,
    lifecycle_state: 'Standard Send Pending',
    stale_alert_sent_bucket: '',
  };
  const review = reviewRow({ created_at_utc: old, updated_at_utc: old, review_alert_sent: true, stale_alert_sent_bucket: '' });
  const summary = executeCodeNode(quoteWorkflow, 'Build Stale Quote Alerts', {
    inputRows: [pending, review],
  }).json;
  assert.equal(summary.alert_needed, true);
  assert.equal(summary.alert_count, 2);
  const alertRows = JSON.parse(summary.alert_rows_json);
  assert.deepEqual(new Set(alertRows.map((row) => row.stale_alert_reason)), new Set(['client_email_pending','needs_review_stale']));

  const email = executeCodeNode(quoteWorkflow, 'Build Stale Quote Alert Email', {
    inputRows: alertRows,
    nodeItems: { 'Emit Stale Alert Intent Rows': alertRows },
  }).json;
  assert.throws(() => executeCodeNode(quoteWorkflow, 'Build Stale Quote Alert Email', {
    inputRows: [],
    nodeItems: { 'Emit Stale Alert Intent Rows': alertRows },
  }), /stale_alert_intent_not_acknowledged/);
  const failed = executeCodeNode(quoteWorkflow, 'Validate Stale Alert Gmail Evidence', {
    input: { error: 'gmail_unavailable' },
    nodeItems: { 'Build Stale Quote Alert Email': [email] },
  }).json;
  assert.equal(failed.provider_confirmed, false);
  assert.equal(executeCodeNode(quoteWorkflow, 'Emit Stale Alert Sent Rows', { input: failed }).length, 0);

  const confirmed = executeCodeNode(quoteWorkflow, 'Validate Stale Alert Gmail Evidence', {
    input: { id: 'stale-message-1', threadId: 'stale-thread-1' },
    nodeItems: { 'Build Stale Quote Alert Email': [email] },
  }).json;
  const sentRows = executeCodeNode(quoteWorkflow, 'Emit Stale Alert Sent Rows', { input: confirmed });
  assert.equal(sentRows.length, 2);
  for (const item of sentRows) {
    assert.equal(item.json.stale_alert_sent_bucket, item.json.stale_alert_pending_bucket);
    assert.equal(item.json.stale_alert_provider_message_id, 'stale-message-1');
    assert.equal(item.json.stale_alert_provider_thread_id, 'stale-thread-1');
  }
});

test('identical duplicate scopes are grouped explicitly for observability rather than pick-first', () => {
  const old = '2020-01-01T00:00:00.000Z';
  const row = { ...resolve(normalize()), created_at_utc: old, updated_at_utc: old, lifecycle_state: 'Standard Send Pending' };
  const result = executeCodeNode(quoteWorkflow, 'Build Stale Quote Alerts', {
    inputRows: [row, { ...row, last_execution_id: 'other-execution' }],
  }).json;
  assert.equal(result.alert_count, 1);
  const grouped = JSON.parse(result.alert_rows_json)[0];
  assert.equal(grouped.duplicate_scope_count, 2);
});

test('stale alert email requires the exact acknowledged physical-row count for each declared group', () => {
  const old = '2020-01-01T00:00:00.000Z';
  const row = { ...resolve(normalize()), created_at_utc: old, updated_at_utc: old, lifecycle_state: 'Standard Send Pending' };
  const summary = executeCodeNode(quoteWorkflow, 'Build Stale Quote Alerts', {
    inputRows: [row, { ...row, last_execution_id: 'duplicate-physical-row' }],
  }).json;
  const grouped = JSON.parse(summary.alert_rows_json)[0];
  assert.equal(grouped.duplicate_scope_count, 2);

  const context = { nodeItems: { 'Emit Stale Alert Intent Rows': [grouped] } };
  assert.throws(() => executeCodeNode(quoteWorkflow, 'Build Stale Quote Alert Email', {
    ...context,
    inputRows: [grouped],
  }), /stale_alert_intent_acknowledgement_count_mismatch/);

  const exact = executeCodeNode(quoteWorkflow, 'Build Stale Quote Alert Email', {
    ...context,
    inputRows: [grouped, { ...grouped }],
  }).json;
  assert.match(exact.email_body_html, /physical rows 2/);

  assert.throws(() => executeCodeNode(quoteWorkflow, 'Build Stale Quote Alert Email', {
    ...context,
    inputRows: [grouped, { ...grouped }, { ...grouped }],
  }), /stale_alert_intent_acknowledgement_count_mismatch/);

  assert.throws(() => executeCodeNode(quoteWorkflow, 'Build Stale Quote Alert Email', {
    inputRows: [grouped, { ...grouped }],
    nodeItems: { 'Emit Stale Alert Intent Rows': [{ ...grouped, duplicate_scope_count: '2' }] },
  }), /invalid_stale_alert_duplicate_scope_count/);
});

test('graph orders durable intent before every Gmail and exposes one responder per webhook lane', () => {
  const workflow = loadWorkflow(quoteWorkflow);
  assert.deepEqual(direct(workflow, 'Filter New Standard Quote'), ['Insert Standard Send Intent']);
  assert.deepEqual(direct(workflow, 'Insert Standard Send Intent'), ['Verify Standard Intent Acknowledgement']);
  assert.deepEqual(direct(workflow, 'Verify Standard Intent Acknowledgement'), ['Send Standard Client Offer']);
  assert.deepEqual(direct(workflow, 'Filter New Review Quote'), ['Insert Review Alert Intent']);
  assert.deepEqual(direct(workflow, 'Insert Review Alert Intent'), ['Verify Review Intent Acknowledgement']);
  assert.deepEqual(direct(workflow, 'Verify Review Intent Acknowledgement'), ['Send Quote Review Alert']);
  assert.deepEqual(direct(workflow, 'Filter Approval Send'), ['Build Approval Send Intent']);
  assert.deepEqual(direct(workflow, 'Build Approval Send Intent'), ['Update Approval Send Intent']);
  assert.deepEqual(direct(workflow, 'Update Approval Send Intent'), ['Verify Approval Send Intent']);
  assert.deepEqual(direct(workflow, 'Verify Approval Send Intent'), ['Send Approved Client Offer']);
  assert.deepEqual(direct(workflow, 'Emit Stale Alert Intent Rows'), ['Update Stale Alert Intent']);
  assert.deepEqual(direct(workflow, 'Update Stale Alert Intent'), ['Build Stale Quote Alert Email']);
  assert.deepEqual(direct(workflow, 'Build Stale Quote Alert Email'), ['Send Stale Quote Alert']);

  const intakeReachable = reachable(workflow, 'Quote Intake Webhook');
  const approvalReachable = reachable(workflow, 'Quote Approval Webhook');
  const responders = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.respondToWebhook').map((node) => node.name);
  assert.deepEqual(responders.sort(), ['Respond Approval Outcome','Respond Quote Outcome']);
  assert.deepEqual(responders.filter((name) => intakeReachable.has(name)), ['Respond Quote Outcome']);
  assert.deepEqual(responders.filter((name) => approvalReachable.has(name)), ['Respond Approval Outcome']);
});

test('all Data Table operations fail-stop and durable reads inspect all exact matches', () => {
  const workflow = loadWorkflow(quoteWorkflow);
  const tables = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.dataTable');
  assert.ok(tables.length >= 10);
  for (const node of tables) assert.equal(node.onError, 'stopWorkflow', node.name);
  for (const name of ['Find Existing Quote Rows','Find Approval Quote Rows','Find Observable Quote Rows']) {
    const node = nodeByName(workflow, name);
    assert.equal(node.parameters.returnAll, true, name);
    assert.equal(Object.hasOwn(node.parameters, 'limit'), false, name);
    assert.equal(node.alwaysOutputData, true, name);
  }
  for (const name of ['Find Existing Quote Rows','Find Approval Quote Rows']) {
    const keys = nodeByName(workflow, name).parameters.filters.conditions.map((condition) => condition.keyName);
    assert.deepEqual(keys, ['submission_id','onboarding_id','smoke_tag'], name);
  }
  for (const node of tables.filter((item) => item.parameters.operation === 'update')) {
    const keys = node.parameters.filters.conditions.map((condition) => condition.keyName);
    assert.deepEqual(keys.slice(0, 5), ['quote_key','submission_id','onboarding_id','smoke_tag','request_fingerprint'], node.name);
    assert.equal(node.alwaysOutputData, true, node.name);
  }
  assert.deepEqual(nodeByName(workflow, 'Update Standard Offer Delivery').parameters.filters.conditions.map((condition) => condition.keyName), [...['quote_key','submission_id','onboarding_id','smoke_tag','request_fingerprint'], 'lifecycle_state']);
  assert.equal(nodeByName(workflow, 'Update Standard Offer Delivery').parameters.filters.conditions.at(-1).keyValue, 'Standard Send Pending');
  assert.equal(nodeByName(workflow, 'Update Approved Offer Delivery').parameters.filters.conditions.at(-1).keyValue, 'Approval Send Pending');
  assert.equal(nodeByName(workflow, 'Update Stale Alert Sent').parameters.filters.conditions.at(-1).keyName, 'stale_alert_pending_bucket');
});

test('workflow is inactive, native-only, placeholder-only, and free of credentials, pin data, private branding, and unsafe metadata', () => {
  const workflow = loadWorkflow(quoteWorkflow);
  const text = fs.readFileSync(quoteWorkflow, 'utf8');
  assert.equal(workflow.active, false);
  assert.equal(Object.hasOwn(workflow, 'pinData'), false);
  assert.equal(Object.hasOwn(workflow.settings, 'availableInMCP'), false);
  assert.equal(workflow.nodes.length, 65);
  const allowedTypes = new Set([
    'n8n-nodes-base.webhook', 'n8n-nodes-base.code', 'n8n-nodes-base.if',
    'n8n-nodes-base.dataTable', 'n8n-nodes-base.gmail', 'n8n-nodes-base.respondToWebhook',
    'n8n-nodes-base.scheduleTrigger',
  ]);
  for (const node of workflow.nodes) {
    assert.ok(allowedTypes.has(node.type), `${node.name}:${node.type}`);
    assert.equal(Object.hasOwn(node, 'credentials'), false, node.name);
  }
  assert.match(text, /REPLACE_WITH_QUOTE_OFFERS_TABLE_ID/);
  assert.equal((text.match(/ops@example\.test/g) || []).length, 2);
  assert.doesNotMatch(text, /Kuliberda|Arise|AR-Day|Day2|availableInMCP|force_review test flag/i);
  assert.doesNotMatch(text, /@[a-z0-9.-]+\.(com|ai|pl)\b/i, 'workflow must not contain a real recipient domain');
});

test('annotated derivative, when present, preserves all functional behavior exactly except positions', () => {
  if (!fs.existsSync(annotatedWorkflow)) return;
  const canonical = loadWorkflow(quoteWorkflow);
  const annotated = loadWorkflow(annotatedWorkflow);
  const functional = (workflow) => workflow.nodes
    .filter((node) => node.type !== 'n8n-nodes-base.stickyNote')
    .map(({ position, ...node }) => node);
  assert.deepEqual(functional(annotated), functional(canonical));
  assert.deepEqual(annotated.connections, canonical.connections);
  assert.equal(annotated.active, false);
  assert.deepEqual(annotated.settings, canonical.settings);
  assert.deepEqual(annotated.tags, canonical.tags);
});
