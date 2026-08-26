'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const { executeCodeNode, loadWorkflow, workflowFile } = require('./helpers/workflow-vm');

const bookingWorkflow = workflowFile('09-booking-lifecycle');
const onboardingWorkflow = workflowFile('08-client-onboarding-saga');
const annotatedWorkflow = bookingWorkflow.replace('workflow.json', 'workflow-annotated-v2.json');

function onboardingBody(overrides = {}) {
  return {
    deal_id: 'deal-booking-contract-001',
    client_external_id: 'client-booking-001',
    client_name: 'Ada Example',
    company: 'Example Client Sp. z o.o.',
    verified_email: 'ada@example.test',
    service_code: 'workflow_build',
    quantity: 1,
    request_details: 'Build and hand over the approved booking workflow.',
    kickoff_slot_start: '2026-09-01T09:00:00+02:00',
    kickoff_slot_end: '2026-09-01T10:00:00+02:00',
    kickoff_slot_tz: 'Europe/Warsaw',
    filename: 'signed-agreement.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'attachment-booking-001',
    ocr_text: 'Signed service agreement between Example Client and Kuliberda Labs. '.repeat(4),
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
    ...overrides,
  };
}

function workflow08BookingRequest(overrides = {}) {
  const normalized = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: { body: onboardingBody(overrides) },
    vars: { ONBOARDING_SMOKE_TAG: 'BOOKING-CONTRACT' },
  }).json;
  assert.equal(normalized.ok, true, normalized.errors?.join(','));
  const step = JSON.parse(normalized.planned_steps_json)
    .find((candidate) => candidate.step_name === 'kickoff_booking');
  assert.ok(step, 'workflow 08 must emit the kickoff_booking step');
  return JSON.parse(step.request_snapshot_bytes);
}

function normalize(request = workflow08BookingRequest()) {
  return executeCodeNode(bookingWorkflow, 'Normalize Booking Request', {
    input: { body: request },
  }).json;
}

function nodeByName(workflow, name) {
  const matches = workflow.nodes.filter((node) => node.name === name);
  assert.equal(matches.length, 1, `expected one node named ${name}`);
  return matches[0];
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

function directSuccessors(workflow, name, branch = 0) {
  return (workflow.connections[name]?.main?.[branch] || []).map((edge) => edge.node);
}

function confirmedRow(normalized, overrides = {}) {
  return {
    ...normalized,
    status: 'confirmed',
    provider_event_status: 'confirmed',
    provider_event_start_utc: normalized.slot_start_utc,
    provider_event_end_utc: normalized.slot_end_utc,
    provider_evidence_json: JSON.stringify({
      source: 'google_calendar_get',
      id: normalized.provider_event_id,
      status: 'confirmed',
      start: normalized.slot_start_utc,
      end: normalized.slot_end_utc,
    }),
    ...overrides,
  };
}

test('workflow 09 accepts the exact workflow 08 booking request and preserves its raw scope', () => {
  const request = workflow08BookingRequest();
  assert.deepEqual(Object.keys(request).sort(), [
    'booking_uid', 'onboarding_id', 'slot_end', 'slot_start', 'slot_tz', 'smoke_tag', 'verified_email',
  ]);

  const result = normalize(request);
  assert.equal(result.valid_input, true, result.errors.join(','));
  assert.equal(result.booking_uid, request.booking_uid);
  assert.equal(result.onboarding_id, request.onboarding_id);
  assert.equal(result.smoke_tag, request.smoke_tag);
  assert.equal(result.verified_email, request.verified_email);
  assert.equal(result.slot_start_utc, '2026-09-01T07:00:00.000Z');
  assert.equal(result.slot_end_utc, '2026-09-01T08:00:00.000Z');
  assert.match(result.request_hash, /^[a-f0-9]{64}$/);
  assert.match(result.scope_key, /^[a-f0-9]{64}$/);
  assert.match(result.intent_key, /^[a-f0-9]{64}$/);
  assert.match(result.provider_event_id, /^bkg[a-f0-9]{48}$/);

  const utcRequest = workflow08BookingRequest({
    kickoff_slot_start: '2026-09-01T09:00:00Z',
    kickoff_slot_end: '2026-09-01T10:00:00Z',
    kickoff_slot_tz: 'UTC',
  });
  assert.equal(normalize(utcRequest).valid_input, true);
});

test('request bytes, hashes, and deterministic provider identity are stable and payload-sensitive', () => {
  const request = workflow08BookingRequest();
  const first = normalize(request);
  const reordered = normalize(Object.fromEntries(Object.entries(request).reverse()));
  assert.equal(first.request_bytes, reordered.request_bytes);
  assert.equal(first.request_hash, reordered.request_hash);
  assert.equal(first.scope_key, reordered.scope_key);
  assert.equal(first.intent_key, reordered.intent_key);
  assert.equal(first.provider_event_id, reordered.provider_event_id);

  const changed = normalize({ ...request, slot_end: '2026-09-01T10:30:00+02:00' });
  assert.equal(changed.scope_key, first.scope_key);
  assert.notEqual(changed.request_hash, first.request_hash);
  assert.notEqual(changed.intent_key, first.intent_key);
  assert.notEqual(changed.provider_event_id, first.provider_event_id);
});

test('malformed, unbounded, padded, non-offset, and invalid-timezone requests fail closed', () => {
  const request = workflow08BookingRequest();
  const fixtures = [
    [{ ...request, slot_tz: 'Mars/Olympus' }, /bad_slot_tz_iana/],
    [{ ...request, slot_start: '2026-09-01T09:00:00' }, /bad_slot_start_explicit_offset_iso/],
    [{ ...request, booking_uid: `${request.onboarding_id}:kickoff:2026-02-30T09:00:00+01:00`, slot_start: '2026-02-30T09:00:00+01:00' }, /bad_slot_start_civil_date/],
    [{ ...request, booking_uid: `${request.onboarding_id}:kickoff:2026-09-01T09:00:00+01:00`, slot_start: '2026-09-01T09:00:00+01:00' }, /slot_start_offset_mismatch_slot_tz/],
    [{ ...request, slot_end: '2026-02-30T10:00:00+01:00' }, /bad_slot_end_civil_date/],
    [{ ...request, slot_end: '2026-09-01T10:00:00+01:00' }, /slot_end_offset_mismatch_slot_tz/],
    [{ ...request, slot_end: request.slot_start }, /slot_start_must_precede_end/],
    [{ ...request, smoke_tag: ` ${request.smoke_tag}` }, /bad_smoke_tag/],
    [{ ...request, onboarding_id: 'owner-alias' }, /bad_onboarding_id_scope/],
    [{ ...request, booking_uid: 'different-booking-uid' }, /booking_uid_must_match_workflow08_derivation/],
    [{ ...request, unexpected: 'not accepted' }, /unknown_field_unexpected/],
    [{ ...request, verified_email: 'not-an-email' }, /bad_verified_email/],
  ];
  for (const [body, error] of fixtures) {
    const result = normalize(body);
    assert.equal(result.valid_input, false, JSON.stringify(body));
    assert.match(result.errors.join(','), error);
  }
});

test('token protection is explicit, server-configured, and precedes validation and state', () => {
  const wrong = executeCodeNode(bookingWorkflow, 'Validate Intake Token', {
    input: { headers: { 'x-booking-token': 'wrong' }, body: workflow08BookingRequest() },
    vars: { BOOKING_INTAKE_TOKEN: 'correct' },
  }).json;
  const missingServer = executeCodeNode(bookingWorkflow, 'Validate Intake Token', {
    input: { headers: { authorization: 'Bearer correct' } },
  }).json;
  const correct = executeCodeNode(bookingWorkflow, 'Validate Intake Token', {
    input: { headers: { authorization: 'Bearer correct' } },
    vars: { BOOKING_INTAKE_TOKEN: 'correct' },
  }).json;
  assert.equal(wrong.auth_ok, false);
  assert.equal(missingServer.auth_ok, false);
  assert.equal(missingServer.auth_reason, 'missing_server_token');
  assert.equal(correct.auth_ok, true);

  const workflow = loadWorkflow(bookingWorkflow);
  assert.deepEqual(directSuccessors(workflow, 'Booking Intake Webhook'), ['Validate Intake Token']);
  assert.deepEqual(directSuccessors(workflow, 'Intake Authorized?', 0), ['Normalize Booking Request']);
  assert.deepEqual(directSuccessors(workflow, 'Intake Authorized?', 1), ['Build Unauthorized Response']);
  const rejected = reachable(workflow, 'Build Unauthorized Response');
  for (const forbidden of ['Find Existing Booking Rows', 'Insert Booking Intent', 'Check Calendar Availability', 'Create Calendar Event', 'Create Confirmation Draft']) {
    assert.equal(rejected.has(forbidden), false, `${forbidden} must not be reachable from rejected auth`);
  }
});

test('durable state resolution distinguishes new, exact replay, changed request, and foreign scope', () => {
  const request = workflow08BookingRequest();
  const normalized = normalize(request);
  const run = (rows) => executeCodeNode(bookingWorkflow, 'Resolve Booking State', {
    inputRows: rows,
    nodeOutputs: { 'Normalize Booking Request': normalized },
  }).json;

  assert.equal(run([]).booking_action, 'create');
  const replay = run([confirmedRow(normalized)]);
  assert.equal(replay.booking_action, 'replay');
  assert.equal(replay.outcome_status, 'confirmed');

  const changedRequest = normalize({ ...request, slot_end: '2026-09-01T10:30:00+02:00' });
  const changed = executeCodeNode(bookingWorkflow, 'Resolve Booking State', {
    inputRows: [confirmedRow(normalized)],
    nodeOutputs: { 'Normalize Booking Request': changedRequest },
  }).json;
  assert.equal(changed.booking_action, 'changed');
  assert.equal(changed.outcome_status, 'reschedule_required');
  assert.match(changed.review_reason, /human_review/);

  const foreign = run([
    confirmedRow(normalized, { onboarding_id: 'b'.repeat(64) }),
    confirmedRow(normalized, { smoke_tag: 'FOREIGN-TAG' }),
  ]);
  assert.equal(foreign.booking_action, 'create');
  assert.equal(foreign.existing_row_count, 0);
});

test('a workflow 08 changed slot changes booking_uid but is held in stable parent scope before Calendar', () => {
  const oldRequest = workflow08BookingRequest();
  const changedRequest = workflow08BookingRequest({
    kickoff_slot_start: '2026-09-01T11:00:00+02:00',
    kickoff_slot_end: '2026-09-01T12:00:00+02:00',
  });
  assert.notEqual(changedRequest.booking_uid, oldRequest.booking_uid);
  const oldNormalized = normalize(oldRequest);
  const changedNormalized = normalize(changedRequest);
  assert.equal(changedNormalized.scope_key, oldNormalized.scope_key);

  const decision = executeCodeNode(bookingWorkflow, 'Resolve Booking State', {
    inputRows: [confirmedRow(oldNormalized)],
    nodeOutputs: { 'Normalize Booking Request': changedNormalized },
  }).json;
  assert.equal(decision.booking_action, 'changed');
  assert.equal(decision.outcome_status, 'reschedule_required');

  const workflow = loadWorkflow(bookingWorkflow);
  assert.deepEqual(directSuccessors(workflow, 'Booking Changed?', 0), ['Build Reschedule Review Row']);
  const heldReach = reachable(workflow, 'Build Reschedule Review Row');
  for (const forbidden of ['Check Calendar Availability', 'Create Calendar Event', 'Get Created Calendar Event', 'Get Stored Calendar Event']) {
    assert.equal(heldReach.has(forbidden), false, `${forbidden} must not be reachable for changed-slot review`);
  }
});

test('ambiguous or unresolved exact replays stop for review without another provider create', () => {
  const normalized = normalize();
  const run = (rows) => executeCodeNode(bookingWorkflow, 'Resolve Booking State', {
    inputRows: rows,
    nodeOutputs: { 'Normalize Booking Request': normalized },
  }).json;
  const pending = run([{ ...normalized, status: 'intent_written' }]);
  assert.equal(pending.booking_action, 'replay');
  assert.equal(pending.outcome_status, 'needs_review');
  assert.match(pending.review_reason, /no_recreate/);

  const ambiguous = run([confirmedRow(normalized), confirmedRow(normalized, { updated_at_utc: 'later' })]);
  assert.equal(ambiguous.outcome_status, 'needs_review');
  assert.match(ambiguous.review_reason, /ambiguous/);

  const conflictingStatus = run([confirmedRow(normalized), { ...normalized, status: 'needs_review' }]);
  assert.equal(conflictingStatus.outcome_status, 'needs_review');
  assert.match(conflictingStatus.review_reason, /no_recreate/);
});

test('confirmed replay rejects tampered, missing, cancelled, or mismatched provider evidence without create', () => {
  const normalized = normalize();
  const valid = confirmedRow(normalized);
  const cancelledEvidence = JSON.stringify({
    source: 'google_calendar_get',
    id: normalized.provider_event_id,
    status: 'cancelled',
    start: normalized.slot_start_utc,
    end: normalized.slot_end_utc,
  });
  const wrongStart = '2026-09-01T06:00:00.000Z';
  const wrongEnd = '2026-09-01T09:00:00.000Z';
  const fixtures = [
    { ...valid, provider_event_id: 'tampered-but-nonempty' },
    { ...valid, provider_event_start_utc: '', provider_event_end_utc: '', provider_evidence_json: '' },
    { ...valid, provider_event_status: 'cancelled', provider_evidence_json: cancelledEvidence },
    { ...valid, provider_event_start_utc: wrongStart, provider_evidence_json: JSON.stringify({ ...JSON.parse(valid.provider_evidence_json), start: wrongStart }) },
    { ...valid, provider_event_end_utc: wrongEnd, provider_evidence_json: JSON.stringify({ ...JSON.parse(valid.provider_evidence_json), end: wrongEnd }) },
    { ...valid, provider_evidence_json: JSON.stringify({ ...JSON.parse(valid.provider_evidence_json), id: 'tampered-evidence-id' }) },
    { ...valid, provider_evidence_json: '{malformed-json' },
  ];
  for (const row of fixtures) {
    const decision = executeCodeNode(bookingWorkflow, 'Resolve Booking State', {
      inputRows: [row],
      nodeOutputs: { 'Normalize Booking Request': normalized },
    }).json;
    assert.equal(decision.booking_action, 'replay');
    assert.equal(decision.outcome_status, 'needs_review');
    assert.match(decision.review_reason, /no_recreate/);
  }

  const workflow = loadWorkflow(bookingWorkflow);
  const replayReach = reachable(workflow, 'Build Replay Response');
  assert.equal(replayReach.has('Create Calendar Event'), false);
  assert.equal(replayReach.has('Check Calendar Availability'), false);
});

test('all provider-create paths pass an acknowledged intent and the changed-slot path cannot mutate Calendar', () => {
  const workflow = loadWorkflow(bookingWorkflow);
  assert.deepEqual(directSuccessors(workflow, 'Insert Booking Intent'), ['Verify Intent Acknowledgement']);
  assert.deepEqual(directSuccessors(workflow, 'Verify Intent Acknowledgement'), ['Check Calendar Availability']);
  assert.deepEqual(directSuccessors(workflow, 'Slot Available?', 0), ['Create Calendar Event']);
  assert.equal(reachable(workflow, 'Build Reschedule Review Row').has('Create Calendar Event'), false);
  assert.equal(reachable(workflow, 'Build Replay Response').has('Create Calendar Event'), false);

  const acknowledgement = nodeByName(workflow, 'Verify Intent Acknowledgement').parameters.jsCode;
  assert.match(acknowledgement, /intent_written_persistence_ack_failed/);
  assert.throws(() => executeCodeNode(bookingWorkflow, 'Verify Intent Acknowledgement', {
    inputRows: [],
    nodeOutputs: { 'Resolve Booking State': { ...normalize(), status: 'intent_written' } },
  }), /intent_written_persistence_ack_failed/);
});

test('Data Table reads and writes fail-stop and use exact raw owner/tag keys', () => {
  const workflow = loadWorkflow(bookingWorkflow);
  const dataNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.dataTable');
  assert.ok(dataNodes.length >= 7);
  assert.ok(dataNodes.every((node) => node.onError === 'stopWorkflow'));

  const lookup = nodeByName(workflow, 'Find Existing Booking Rows');
  assert.deepEqual(lookup.parameters.filters.conditions.map((filter) => filter.keyName), [
    'onboarding_id', 'smoke_tag',
  ]);
  assert.match(lookup.parameters.filters.conditions[0].keyValue, /onboarding_id/);
  assert.match(lookup.parameters.filters.conditions[1].keyValue, /smoke_tag/);
  for (const name of ['Update Booking Busy', 'Update Booking Confirmed', 'Update Reconciled Booking']) {
    const keys = nodeByName(workflow, name).parameters.filters.conditions.map((filter) => filter.keyName);
    assert.deepEqual(keys, ['booking_uid', 'onboarding_id', 'smoke_tag', 'request_hash', 'status']);
  }
});

test('created event validation requires matching non-cancelled provider-shaped evidence', () => {
  const normalized = normalize();
  const valid = {
    id: normalized.provider_event_id,
    status: 'confirmed',
    start: { dateTime: normalized.slot_start_utc },
    end: { dateTime: normalized.slot_end_utc },
  };
  const result = executeCodeNode(bookingWorkflow, 'Validate Created Event', {
    input: valid,
    nodeOutputs: { 'Normalize Booking Request': normalized },
  }).json;
  assert.equal(result.provider_event_id, normalized.provider_event_id);
  assert.equal(result.provider_event_status, 'confirmed');

  for (const event of [
    { ...valid, id: '' },
    { ...valid, id: 'another-event' },
    { ...valid, status: 'cancelled' },
    { ...valid, start: { dateTime: normalized.slot_end_utc } },
  ]) {
    assert.throws(() => executeCodeNode(bookingWorkflow, 'Validate Created Event', {
      input: event,
      nodeOutputs: { 'Normalize Booking Request': normalized },
    }), /calendar_create_provider_evidence_invalid/);
  }
});

test('provider readback gates confirmation and emits workflow 08-compatible Booking evidence', () => {
  const normalized = normalize();
  const event = {
    id: normalized.provider_event_id,
    status: 'confirmed',
    start: { dateTime: normalized.slot_start_utc },
    end: { dateTime: normalized.slot_end_utc },
  };
  const validated = executeCodeNode(bookingWorkflow, 'Validate Provider Readback', {
    input: event,
    nodeOutputs: { 'Normalize Booking Request': normalized },
  }).json;
  assert.equal(validated.status, 'confirmed');
  assert.equal(validated.booking_uid, normalized.booking_uid);
  assert.equal(validated.onboarding_id, normalized.onboarding_id);
  assert.equal(validated.smoke_tag, normalized.smoke_tag);
  assert.equal(validated.slot_start_utc, normalized.slot_start_utc);
  assert.equal(validated.provider_event_id, event.id);
  assert.equal(JSON.parse(validated.provider_evidence_json).source, 'google_calendar_get');

  const acknowledged = executeCodeNode(bookingWorkflow, 'Verify Booking Confirmation Ack', {
    inputRows: [validated],
    nodeOutputs: { 'Validate Provider Readback': validated },
  }).json;
  assert.equal(acknowledged.status, 'confirmed');
  assert.throws(() => executeCodeNode(bookingWorkflow, 'Verify Booking Confirmation Ack', {
    inputRows: [],
    nodeOutputs: { 'Validate Provider Readback': validated },
  }), /confirmed_persistence_ack_failed/);
});

test('reconcile adopts an exact stored provider event and holds missing, duplicate, or mismatched state', () => {
  const normalized = normalize();
  const intent = { ...normalized, status: 'intent_written' };
  const candidates = executeCodeNode(bookingWorkflow, 'Build Reconcile Candidates', {
    inputRows: [intent],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].json.lookup_safe, true);

  const event = {
    id: normalized.provider_event_id,
    status: 'confirmed',
    start: { dateTime: normalized.slot_start_utc },
    end: { dateTime: normalized.slot_end_utc },
  };
  const adopted = executeCodeNode(bookingWorkflow, 'Resolve Reconcile Provider State', {
    input: event,
    nodeOutputs: { 'Build Reconcile Candidates': candidates[0].json },
  }).json;
  assert.equal(adopted.status, 'confirmed');
  assert.equal(JSON.parse(adopted.provider_evidence_json).source, 'reconcile_google_calendar_get');

  const mismatch = executeCodeNode(bookingWorkflow, 'Resolve Reconcile Provider State', {
    input: { ...event, id: 'different-provider-id' },
    nodeOutputs: { 'Build Reconcile Candidates': candidates[0].json },
  }).json;
  assert.equal(mismatch.status, 'needs_review');
  assert.match(mismatch.review_reason, /no_recreate/);

  const duplicate = executeCodeNode(bookingWorkflow, 'Build Reconcile Candidates', {
    inputRows: [intent, { ...intent, updated_at_utc: 'later' }],
  });
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].json.lookup_safe, false);
  assert.equal(duplicate[0].json.status, 'needs_review');
  assert.match(duplicate[0].json.review_reason, /ambiguous_parent_scope/);

  const tamperedIdentity = executeCodeNode(bookingWorkflow, 'Build Reconcile Candidates', {
    inputRows: [{ ...intent, provider_event_id: 'bkgdifferentprovideridentity001' }],
  });
  assert.equal(tamperedIdentity.length, 1);
  assert.equal(tamperedIdentity[0].json.lookup_safe, false);
  assert.equal(tamperedIdentity[0].json.status, 'needs_review');

  const changed = normalize(workflow08BookingRequest({
    kickoff_slot_start: '2026-09-01T11:00:00+02:00',
    kickoff_slot_end: '2026-09-01T12:00:00+02:00',
  }));
  const parentConflict = executeCodeNode(bookingWorkflow, 'Build Reconcile Candidates', {
    inputRows: [intent, { ...changed, status: 'intent_written' }],
  });
  assert.equal(parentConflict.length, 2);
  assert.ok(parentConflict.every((item) => item.json.lookup_safe === false));
  assert.ok(parentConflict.every((item) => item.json.status === 'needs_review'));
  assert.ok(parentConflict.every((item) => /ambiguous_parent_scope/.test(item.json.review_reason)));
});

test('reconcile has get-only provider topology and can never reach Calendar create', () => {
  const workflow = loadWorkflow(bookingWorkflow);
  const reconcileReach = reachable(workflow, 'Booking Reconcile Schedule');
  assert.equal(reconcileReach.has('Create Calendar Event'), false);
  assert.equal(reconcileReach.has('Check Calendar Availability'), false);
  assert.equal(reconcileReach.has('Create Confirmation Draft'), false);
  assert.equal(reconcileReach.has('Get Stored Calendar Event'), true);
  assert.deepEqual(directSuccessors(workflow, 'Provider Lookup Safe?', 1), ['Update Reconciled Booking']);
  assert.equal(nodeByName(workflow, 'Get Stored Calendar Event').parameters.operation, 'get');
});

test('all seven selected fixture modes execute their terminal assertion Code node', () => {
  const selected = executeCodeNode(bookingWorkflow, 'Select Fixture Scenario').json;
  assert.equal(selected.fixture_mode, 'available');
  assert.deepEqual(selected.fixture_scenarios, [
    'available', 'busy', 'replay', 'invalid-timezone', 'failed-before-send',
    'provider-success/ack-failure', 'changed-slot',
  ]);
  const catalog = JSON.parse(selected.fixture_catalog_json);
  const terminals = {
    available: 'Fixture Available',
    busy: 'Fixture Busy',
    replay: 'Fixture Replay',
    'invalid-timezone': 'Fixture Invalid Timezone',
    'failed-before-send': 'Fixture Failed Before Send',
    'provider-success/ack-failure': 'Fixture Provider Success Ack Failure',
    'changed-slot': 'Fixture Changed Slot',
  };
  for (const [mode, terminal] of Object.entries(terminals)) {
    const result = executeCodeNode(bookingWorkflow, terminal, { input: catalog[mode] });
    assert.equal(result.json.fixture_mode, mode);
    assert.equal(result.json.fixture_result, 'pass');
  }
});

test('manual fixtures are a ten-node disconnected local-only component', () => {
  const workflow = loadWorkflow(bookingWorkflow);
  const fixtureReach = reachable(workflow, 'Booking Fixture Manual Trigger');
  assert.equal(fixtureReach.size, 10);
  const allowed = new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.code', 'n8n-nodes-base.switch']);
  for (const name of fixtureReach) assert.ok(allowed.has(nodeByName(workflow, name).type), `${name} is not fixture-local`);
  for (const forbiddenType of ['n8n-nodes-base.dataTable', 'n8n-nodes-base.googleCalendar', 'n8n-nodes-base.gmail']) {
    assert.equal([...fixtureReach].some((name) => nodeByName(workflow, name).type === forbiddenType), false);
  }
  assert.deepEqual(directSuccessors(workflow, 'Booking Fixture Manual Trigger'), ['Select Fixture Scenario']);
  assert.deepEqual(directSuccessors(workflow, 'Select Fixture Scenario'), ['Route Booking Fixture']);
  assert.doesNotMatch(nodeByName(workflow, 'Select Fixture Scenario').parameters.jsCode, /\$vars/);
});

test('workflow is inactive, import-safe, native-only, and uses current Calendar/Gmail operation shapes', () => {
  const workflow = loadWorkflow(bookingWorkflow);
  assert.equal(workflow.active, false);
  assert.equal(Object.prototype.hasOwnProperty.call(workflow, 'pinData'), false);
  assert.equal(workflow.nodes.length, 53);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.webhook').length, 1);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.manualTrigger').length, 1);
  for (const node of workflow.nodes) {
    assert.equal(Object.prototype.hasOwnProperty.call(node, 'credentials'), false, node.name);
    assert.ok(node.type.startsWith('n8n-nodes-base.'), `${node.name} must be native`);
  }

  const calendars = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.googleCalendar');
  assert.deepEqual(calendars.map((node) => [node.parameters.resource, node.parameters.operation]), [
    ['calendar', 'availability'], ['event', 'create'], ['event', 'get'], ['event', 'get'],
  ]);
  assert.ok(calendars.every((node) => node.typeVersion === 1.3));
  const availability = nodeByName(workflow, 'Check Calendar Availability');
  assert.equal(availability.parameters.options.outputFormat, 'availability');
  assert.match(availability.parameters.options.timezone.value, /slot_tz/);
  const create = nodeByName(workflow, 'Create Calendar Event');
  assert.match(create.parameters.additionalFields.id, /provider_event_id/);
  assert.equal(create.parameters.additionalFields.sendUpdates, 'none');
  assert.match(nodeByName(workflow, 'Get Created Calendar Event').parameters.eventId, /provider_event_id/);
  assert.match(nodeByName(workflow, 'Get Stored Calendar Event').parameters.eventId, /provider_event_id/);

  const gmail = nodeByName(workflow, 'Create Confirmation Draft');
  assert.equal(gmail.typeVersion, 2.2);
  assert.equal(gmail.parameters.resource, 'draft');
  assert.equal(gmail.parameters.operation, 'create');
  assert.equal(gmail.onError, 'continueRegularOutput');
  assert.ok(gmail.parameters.options.sendTo);
  assert.equal(Object.prototype.hasOwnProperty.call(gmail.parameters.options, 'toList'), false);
  assert.equal(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.gmail' && node.parameters.operation === 'send'), false);
});

test('canonical and annotated artifacts preserve exact behavior outside positions and sticky notes', {
  skip: !fs.existsSync(annotatedWorkflow),
}, () => {
  const canonical = loadWorkflow(bookingWorkflow);
  const annotated = loadWorkflow(annotatedWorkflow);
  const normalizeArtifact = (workflow) => ({
    ...workflow,
    nodes: workflow.nodes
      .filter((node) => node.type !== 'n8n-nodes-base.stickyNote')
      .map(({ position, ...node }) => node),
  });
  assert.deepEqual(normalizeArtifact(annotated), normalizeArtifact(canonical));

  const raw = fs.readFileSync(annotatedWorkflow);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex').length, 64);
});
