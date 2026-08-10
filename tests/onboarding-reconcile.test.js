'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { executeCodeNode, loadWorkflow, workflowFile } = require('./helpers/workflow-vm');

const onboardingWorkflow = workflowFile('08-client-onboarding-saga');
const documentWorkflow = workflowFile('03-document-intake');
const oldTime = '2026-01-01T00:00:00.000Z';
const longOcrText = 'Signed service agreement between Example Client and Kuliberda Labs. '.repeat(4);

function normalizeOnboarding(dealId) {
  return executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: { body: {
      deal_id: dealId,
      client_name: 'Ada Example',
      company: 'Example Client Sp. z o.o.',
      verified_email: 'owner@example.test',
      service_code: 'workflow_build',
      quantity: 2,
      request_details: 'Build the same approved workflow.',
      kickoff_slot_start: '2026-09-01T09:00:00Z',
      kickoff_slot_end: '2026-09-01T10:00:00Z',
      kickoff_slot_tz: 'UTC',
      filename: 'same-signed-agreement.pdf',
      mime_type: 'application/pdf',
      file_sha256: 'd'.repeat(64),
      ocr_text: longOcrText,
      ocr_confidence: 0.99,
      scan_text_ratio: 0.95,
    } },
  }).json;
}

function plannedStep(normalized, stepName) {
  return JSON.parse(normalized.planned_steps_json).find((step) => step.step_name === stepName);
}

function normalizeDocument(request) {
  return executeCodeNode(documentWorkflow, 'Normalize Document Intake', {
    input: { body: request },
  }).json;
}

function parentRow(onboardingId, state = 'UNKNOWN_CHILD_RESULT', requiredSteps = ['first_invoice', 'welcome_email']) {
  return {
    onboarding_id: onboardingId,
    onboarding_identity: `deal-${onboardingId}`,
    identity_source: 'deal_id',
    state,
    client_name: `Client ${onboardingId}`,
    company: `Company ${onboardingId}`,
    verified_email: `${onboardingId}@example.test`,
    service_code: 'workflow_build',
    created_at_utc: oldTime,
    updated_at_utc: oldTime,
    last_progress_at_utc: oldTime,
    required_steps_json: JSON.stringify(requiredSteps),
    step_summary_json: '[]',
    blocked_reason: state === 'UNKNOWN_CHILD_RESULT' ? 'unknown_child_result' : '',
    smoke_tag: `TAG-${onboardingId}`,
    last_execution_id: 'prior-execution',
  };
}

function stepRow(onboardingId, overrides = {}) {
  const stepName = overrides.step_name || 'first_invoice';
  const predictedKey = overrides.predicted_child_key || `invoice-${onboardingId}`;
  const state = overrides.state || 'UNKNOWN_CHILD_RESULT';
  return {
    step_key: `${onboardingId}:${stepName}`,
    onboarding_id: onboardingId,
    step_name: stepName,
    step_version: `onboarding.${stepName}.v1`,
    state,
    child_day: overrides.child_day || 'Invoice',
    registry_row: 'test registry row',
    workflow_id: 'EXTERNAL_TEST_WORKFLOW',
    child_version_id: 'child-v1',
    request_snapshot_bytes: JSON.stringify(overrides.request || { job_id: `${onboardingId}:first_invoice` }),
    request_snapshot_hash: `snapshot-${onboardingId}-${stepName}`,
    predicted_child_key: predictedKey,
    child_status: state === 'UNKNOWN_CHILD_RESULT' ? 'no_terminal_child_row' : 'already_terminal',
    child_proof_json: state === 'UNKNOWN_CHILD_RESULT'
      ? JSON.stringify({ retry_legal: false, reason: 'missing_child_table_evidence', predicted_child_key: predictedKey })
      : JSON.stringify({ source: 'fixture' }),
    side_effect_policy: 'cannot_unsend_invoice',
    created_at_utc: oldTime,
    updated_at_utc: oldTime,
    last_progress_at_utc: oldTime,
    blocked_reason: state === 'UNKNOWN_CHILD_RESULT' ? 'no_terminal_child_row' : '',
    smoke_tag: `TAG-${onboardingId}`,
    last_execution_id: 'prior-execution',
    ...overrides,
  };
}

function terminalCompanion(onboardingId) {
  return stepRow(onboardingId, {
    step_name: 'welcome_email',
    state: 'TERMINAL_SUCCESS',
    child_day: 'Parent',
    predicted_child_key: `welcome-${onboardingId}`,
    child_status: 'controlled_welcome_recorded',
    blocked_reason: '',
  });
}

function reconcile({ parents, steps, invoices = [], offers = [], bookings = [], documents = [], alerts = [] }) {
  return executeCodeNode(onboardingWorkflow, 'Build UTC Reconcile Alerts', {
    nodeItems: {
      'Find Reconcile Onboarding Rows': parents,
      'Find Reconcile Step Rows': steps,
      'Find Reconcile Offer Rows': offers,
      'Find Reconcile Invoice Rows': invoices,
      'Find Reconcile Booking Rows': bookings,
      'Find Reconcile Document Rows': documents,
      'Find Existing Reconcile Alert Rows': alerts,
    },
  }).json;
}

function adoptedRows(reconcileResult) {
  return JSON.parse(reconcileResult.adopted_step_rows_json);
}

function parentRepairRows(reconcileResult) {
  return JSON.parse(reconcileResult.parent_repair_step_rows_json || '[]');
}

function rollup({ parents, storedSteps, adoptions }) {
  const result = executeCodeNode(onboardingWorkflow, 'Build Reconcile Parent Rollups', {
    inputRows: adoptions,
    nodeItems: {
      'Find Reconcile Onboarding Rows': parents,
      'Find Reconcile Step Rows': storedSteps,
    },
  });
  return result.map((item) => JSON.parse(item.json.final_onboarding_row_json));
}

function replaceAdopted(storedSteps, adoptions) {
  const byStepKey = new Map(adoptions.map((row) => [row.step_key, row]));
  return storedSteps.map((row) => byStepKey.get(row.step_key) || row);
}

function terminalUpdateValue(expression, row) {
  if (expression === '={{ $json.match_step_key || $json.step_key }}') return row.match_step_key || row.step_key;
  if (expression === '={{ $json.onboarding_id }}') return row.onboarding_id;
  if (expression === '={{ $json.smoke_tag }}') return row.smoke_tag;
  throw new Error(`unsupported terminal update filter expression: ${expression}`);
}

function terminalUpdateMatches(storedRow, emittedRow, conditions) {
  return conditions.every((condition) => (
    condition.condition === 'eq'
    && storedRow[condition.keyName] === terminalUpdateValue(condition.keyValue, emittedRow)
  ));
}

function parentUpdateValue(value, emittedRow) {
  if (value === '={{ $json.onboarding_id }}') return emittedRow.onboarding_id;
  if (value === '={{ $json.smoke_tag }}') return emittedRow.smoke_tag;
  return value;
}

function parentUpdateMatches(storedRow, emittedRow, conditions) {
  return conditions.every((condition) => {
    const expected = parentUpdateValue(condition.keyValue, emittedRow);
    if (condition.condition === 'eq') return storedRow[condition.keyName] === expected;
    if (condition.condition === 'neq') return storedRow[condition.keyName] !== expected;
    throw new Error(`unsupported parent update condition: ${condition.condition}`);
  });
}

function simulateParentUpdate(storedRows, emittedRow, conditions) {
  const matchingIndexes = storedRows
    .map((row, index) => (parentUpdateMatches(row, emittedRow, conditions) ? index : -1))
    .filter((index) => index >= 0);
  return {
    matchingIndexes,
    rows: storedRows.map((row, index) => (
      matchingIndexes.includes(index) ? { ...row, ...emittedRow } : structuredClone(row)
    )),
  };
}

const conflictFixtures = {
  Offer: {
    stepName: 'offer_out',
    webhookNode: 'Find Offer Rows',
    reconcileField: 'offers',
    keyedRow: (step, row) => ({ submission_id: step.predicted_child_key, onboarding_id: step.onboarding_id, smoke_tag: step.smoke_tag, ...row }),
    success: { status: 'Offer Sent' },
    review: { status: 'Needs Review' },
    deadLetter: { status: 'Dead Letter' },
    ambiguous: { status: 'Processing' },
  },
  Invoice: {
    stepName: 'first_invoice',
    webhookNode: 'Find Invoice Rows',
    reconcileField: 'invoices',
    keyedRow: (step, row) => ({ invoice_key: step.predicted_child_key, onboarding_id: step.onboarding_id, smoke_tag: step.smoke_tag, ...row }),
    success: { status: 'Invoice Sent' },
    review: { status: 'Needs Review' },
    deadLetter: { status: 'Dead Letter' },
    ambiguous: { status: 'Processing' },
  },
  Booking: {
    stepName: 'kickoff_booking',
    webhookNode: 'Find Booking Rows',
    reconcileField: 'bookings',
    keyedRow: (step, row) => ({ booking_uid: step.predicted_child_key, onboarding_id: step.onboarding_id, smoke_tag: step.smoke_tag, ...row }),
    success: { status: 'Confirmed', slot_start_utc: '2026-09-01T09:00:00Z' },
    review: { status: 'Needs Review', slot_start_utc: '2026-09-01T09:00:00Z' },
    deadLetter: { status: 'Dead Letter', slot_start_utc: '2026-09-01T09:00:00Z' },
    ambiguous: { status: 'Processing', slot_start_utc: '2026-09-01T09:00:00Z' },
    reschedule: { status: 'Confirmed', slot_start_utc: '2026-09-02T09:00:00Z' },
  },
  Document: {
    stepName: 'signed_document',
    webhookNode: 'Find Document Rows',
    reconcileField: 'documents',
    keyedRow: (step, row) => ({ document_key: step.predicted_child_key, onboarding_id: step.onboarding_id, smoke_tag: step.smoke_tag, ...row }),
    success: { status: 'Filed' },
    review: { status: 'Needs Review' },
    deadLetter: { status: 'Dead Letter' },
    ambiguous: { status: 'Processing' },
  },
};

function conflictStep(onboardingId, childDay) {
  const fixture = conflictFixtures[childDay];
  return stepRow(onboardingId, {
    step_name: fixture.stepName,
    child_day: childDay,
    predicted_child_key: `${childDay.toLowerCase()}-${onboardingId}`,
    request: childDay === 'Booking'
      ? { booking_uid: `booking-${onboardingId}`, slot_start: '2026-09-01T09:00:00Z' }
      : { onboarding_id: onboardingId },
  });
}

function scopedChildRow(step, row) {
  return { onboarding_id: step.onboarding_id, smoke_tag: step.smoke_tag, ...row };
}

function webhookEvidenceDecision(step, childRows) {
  const fixture = conflictFixtures[step.child_day];
  const pending = { ...step, state: 'INTENT_WRITTEN', child_status: '', child_proof_json: '', blocked_reason: '' };
  const parent = { ...parentRow(step.onboarding_id, 'UNKNOWN_CHILD_RESULT', [step.step_name]), smoke_tag: step.smoke_tag };
  const result = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': {
        ...parent,
        errors: [],
        planned_steps_json: JSON.stringify([pending]),
        child_fixtures_json: '{}',
        test_overrides_enabled: false,
        current_kickoff_slot_valid: true,
        current_kickoff_slot_start_utc: '2026-09-01T09:00:00Z',
      },
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: JSON.stringify([pending]),
        intent_rows_json: '[]',
        replay_noop: false,
      },
    },
    nodeItems: { [fixture.webhookNode]: childRows },
  }).json;
  const terminalRows = JSON.parse(result.terminal_rows_json);
  assert.equal(terminalRows.length, 1, `${step.child_day}: webhook must persist the aggregate decision`);
  return {
    state: terminalRows[0].state,
    status: terminalRows[0].child_status,
    proof: JSON.parse(terminalRows[0].child_proof_json),
    parentState: JSON.parse(result.final_onboarding_row_json).state,
  };
}

function reconcileEvidenceDecision(step, childRows) {
  const fixture = conflictFixtures[step.child_day];
  const parent = { ...parentRow(step.onboarding_id, 'UNKNOWN_CHILD_RESULT', [step.step_name]), smoke_tag: step.smoke_tag };
  const args = { parents: [parent], steps: [step], [fixture.reconcileField]: childRows };
  const result = reconcile(args);
  const emitted = adoptedRows(result);
  assert.equal(emitted.length, 1, `${step.child_day}: reconcile must persist the aggregate decision`);
  const rolled = rollup({ parents: [parent], storedSteps: [step], adoptions: emitted });
  assert.equal(rolled.length, 1, `${step.child_day}: reconcile must roll up its aggregate decision`);
  return {
    state: emitted[0].state,
    status: emitted[0].child_status,
    proof: JSON.parse(emitted[0].child_proof_json),
    parentState: rolled[0].state,
  };
}

function storedSuccessStep(onboardingId, childDay) {
  const fixture = conflictFixtures[childDay];
  return {
    ...conflictStep(onboardingId, childDay),
    state: 'TERMINAL_SUCCESS',
    child_status: fixture.success.status,
    child_proof_json: JSON.stringify({ source: 'previous_terminal_evidence' }),
    blocked_reason: '',
  };
}

function webhookStoredTerminalReplay(step, childRows) {
  const fixture = conflictFixtures[step.child_day];
  const parentState = step.state === 'TERMINAL_SUCCESS'
    ? 'COMPLETE'
    : (['TERMINAL_REVIEW','HUMAN_REQUIRED'].includes(step.state) ? 'HUMAN_REQUIRED' : (step.state === 'UNKNOWN_CHILD_RESULT' ? 'UNKNOWN_CHILD_RESULT' : 'PARTIAL_BLOCKED'));
  const parent = {
    ...parentRow(step.onboarding_id, parentState, [step.step_name]),
    blocked_reason: parentState === 'COMPLETE'
      ? ''
      : `${step.step_name}:${step.state === 'TERMINAL_DEAD_LETTER' ? 'dead_letter' : (step.child_status || step.state.toLowerCase())}`,
    step_summary_json: JSON.stringify([{
      onboarding_id: step.onboarding_id,
      step_key: step.step_key,
      step_name: step.step_name,
      state: step.state,
      status: step.child_status || '',
      predicted_child_key: step.predicted_child_key || '',
    }]),
  };
  const result = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': {
        ...parent,
        errors: [],
        planned_steps_json: JSON.stringify([step]),
        child_fixtures_json: '{}',
        test_overrides_enabled: false,
        current_kickoff_slot_valid: true,
        current_kickoff_slot_start_utc: '2026-09-01T09:00:00Z',
      },
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: JSON.stringify([step]),
        intent_rows_json: '[]',
        replay_noop: true,
      },
    },
    nodeItems: {
      'Find Existing Onboarding Rows': [parent],
      [fixture.webhookNode]: childRows,
    },
  }).json;
  const response = JSON.parse(result.response_body_json);
  const emitted = JSON.parse(result.terminal_rows_json);
  return {
    decisionState: response.decisions[0].state,
    decisionStatus: response.decisions[0].status,
    emitted: emitted.map((row) => ({
      state: row.state,
      status: row.child_status,
      proof: JSON.parse(row.child_proof_json),
      onboardingId: row.onboarding_id,
      smokeTag: row.smoke_tag,
    })),
    shouldWriteParent: result.should_insert_final_onboarding,
    parentState: JSON.parse(result.final_onboarding_row_json).state,
    replayNoop: response.replay_noop,
  };
}

function reconcileStoredTerminalReplay(step, childRows) {
  const fixture = conflictFixtures[step.child_day];
  const parent = {
    ...parentRow(step.onboarding_id, 'COMPLETE', [step.step_name]),
    step_summary_json: JSON.stringify([{
      onboarding_id: step.onboarding_id,
      step_key: step.step_key,
      step_name: step.step_name,
      state: step.state,
      status: step.child_status || '',
      predicted_child_key: step.predicted_child_key || '',
    }]),
  };
  const args = { parents: [parent], steps: [step], [fixture.reconcileField]: childRows };
  const result = reconcile(args);
  const emitted = adoptedRows(result);
  const rolled = rollup({ parents: [parent], storedSteps: [step], adoptions: emitted });
  return {
    adoptionCount: result.adoption_count,
    parentRepairCount: result.parent_repair_count,
    emitted: emitted.map((row) => ({
      state: row.state,
      status: row.child_status,
      proof: JSON.parse(row.child_proof_json),
      onboardingId: row.onboarding_id,
      smokeTag: row.smoke_tag,
    })),
    parentState: rolled[0]?.state || parent.state,
  };
}

function duplicateInvoiceStep(onboardingId, stepKey, predictedKey, state = 'UNKNOWN_CHILD_RESULT') {
  return stepRow(onboardingId, {
    step_key: stepKey,
    step_name: 'first_invoice',
    child_day: 'Invoice',
    predicted_child_key: predictedKey,
    state,
    child_status: state === 'TERMINAL_SUCCESS' ? 'Invoice Sent' : 'no_terminal_child_row',
    child_proof_json: state === 'TERMINAL_SUCCESS'
      ? JSON.stringify({ source: 'Dunning_Invoices', adopted_by: predictedKey })
      : JSON.stringify({ retry_legal: false, reason: 'missing_child_table_evidence', predicted_child_key: predictedKey }),
    blocked_reason: state === 'TERMINAL_SUCCESS' ? '' : 'no_terminal_child_row',
    request: { job_id: `${onboardingId}:${stepKey}` },
  });
}

function webhookDuplicateDecision(normalized, rows) {
  const source = {
    ...normalized,
    required_steps_json: JSON.stringify(['first_invoice']),
    planned_steps_json: JSON.stringify(rows),
    errors: [],
    child_fixtures_json: '{}',
    test_overrides_enabled: false,
    current_kickoff_slot_valid: true,
  };
  const result = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': source,
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: JSON.stringify(rows),
        intent_rows_json: '[]',
        replay_noop: false,
      },
    },
  }).json;
  const finalParent = JSON.parse(result.final_onboarding_row_json);
  return {
    state: finalParent.state,
    blockedReason: finalParent.blocked_reason,
    summary: JSON.parse(finalParent.step_summary_json),
  };
}

function webhookFromStoredRows({ source, parent, steps, storedParents = [parent], nodeItems = {} }) {
  const claim = executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
    inputRows: storedParents,
    nodeOutputs: { 'Normalize Onboarding': source },
  }).json;
  const summary = executeCodeNode(onboardingWorkflow, 'Build Missing Step Intent Summary', {
    inputRows: steps,
    nodeOutputs: {
      'Normalize Onboarding': source,
      'Build Claim Decision': claim,
    },
  }).json;
  return executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': source,
      'Build Missing Step Intent Summary': summary,
    },
    nodeItems: {
      'Find Existing Onboarding Rows': storedParents,
      ...nodeItems,
    },
  }).json;
}

function webhookChainFromStoredRows({ source, steps, storedParents, nodeItems = {} }) {
  const claim = executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
    inputRows: storedParents,
    nodeOutputs: { 'Normalize Onboarding': source },
  }).json;
  const summary = executeCodeNode(onboardingWorkflow, 'Build Missing Step Intent Summary', {
    inputRows: steps,
    nodeOutputs: {
      'Normalize Onboarding': source,
      'Build Claim Decision': claim,
    },
  }).json;
  const parentDecision = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': source,
      'Build Missing Step Intent Summary': summary,
    },
    nodeItems: {
      'Find Existing Onboarding Rows': storedParents,
      ...nodeItems,
    },
  }).json;
  return { claim, summary, parentDecision };
}

test('UNKNOWN_CHILD_RESULT keeps retry_legal false but actual parent code can recheck late evidence', () => {
  const parent = parentRow('parent-code');
  const intent = stepRow('parent-code', { state: 'INTENT_WRITTEN' });
  const source = {
    ...parent,
    errors: [],
    planned_steps_json: JSON.stringify([intent]),
    child_fixtures_json: '{}',
    test_overrides_enabled: false,
    current_kickoff_slot_valid: true,
  };
  const first = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': source,
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: JSON.stringify([intent]),
        intent_rows_json: '[]',
        replay_noop: false,
      },
    },
  }).json;
  const unknown = JSON.parse(first.terminal_rows_json)[0];
  assert.equal(unknown.state, 'UNKNOWN_CHILD_RESULT');
  assert.equal(JSON.parse(unknown.child_proof_json).retry_legal, false);

  const second = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': { ...source, planned_steps_json: JSON.stringify([unknown]) },
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: JSON.stringify([unknown]),
        intent_rows_json: '[]',
        replay_noop: false,
      },
    },
    nodeItems: {
      'Find Invoice Rows': [scopedChildRow(unknown, { invoice_key: unknown.predicted_child_key, invoice_email_sent: true })],
    },
  }).json;
  assert.equal(JSON.parse(second.response_body_json).decisions[0].state, 'TERMINAL_SUCCESS');
});

test('reconcile adopts unknown late success and recomputes the affected parent COMPLETE', () => {
  const parent = parentRow('late-success');
  const unknown = stepRow(parent.onboarding_id);
  const companion = terminalCompanion(parent.onboarding_id);
  const result = reconcile({
    parents: [parent],
    steps: [unknown, companion],
    invoices: [scopedChildRow(unknown, { invoice_key: unknown.predicted_child_key, status: 'Invoice Sent' })],
  });
  const adoptions = adoptedRows(result);
  assert.equal(result.adoption_count, 1);
  assert.equal(adoptions[0].step_key, unknown.step_key);
  assert.equal(adoptions[0].state, 'TERMINAL_SUCCESS');

  const parents = rollup({ parents: [parent], storedSteps: [unknown, companion], adoptions });
  assert.equal(parents.length, 1);
  assert.equal(parents[0].onboarding_id, parent.onboarding_id);
  assert.equal(parents[0].state, 'COMPLETE');
  assert.deepEqual(
    JSON.parse(parents[0].step_summary_json).map((row) => [row.step_key, row.state]).sort(),
    [[companion.step_key, 'TERMINAL_SUCCESS'], [unknown.step_key, 'TERMINAL_SUCCESS']].sort(),
  );
});

test('CANCELLED parent suppresses exact late success adoption and direct reconcile rollup', () => {
  const parent = {
    ...parentRow('cancelled-late-success', 'CANCELLED'),
    blocked_reason: 'cancelled_by_operator',
  };
  const unknown = stepRow(parent.onboarding_id);
  const companion = terminalCompanion(parent.onboarding_id);
  const result = reconcile({
    parents: [parent],
    steps: [unknown, companion],
    invoices: [scopedChildRow(unknown, { invoice_key: unknown.predicted_child_key, status: 'Invoice Sent' })],
  });
  const adoptions = adoptedRows(result);
  const rolled = rollup({ parents: [parent], storedSteps: [unknown, companion], adoptions });

  assert.deepEqual({
    adoptionCount: result.adoption_count,
    adoptedStates: adoptions.map((row) => row.state),
    parentRepairCount: result.parent_repair_count,
    rolledStates: rolled.map((row) => row.state),
  }, {
    adoptionCount: 0,
    adoptedStates: [],
    parentRepairCount: 0,
    rolledStates: [],
  });
  assert.deepEqual(parentRepairRows(result), []);

  const injectedSuccess = {
    ...unknown,
    match_step_key: unknown.step_key,
    state: 'TERMINAL_SUCCESS',
    child_status: 'Invoice Sent',
    child_proof_json: JSON.stringify({ source: 'synthetic_direct_rollup_guard' }),
    blocked_reason: '',
  };
  assert.deepEqual(
    rollup({ parents: [parent], storedSteps: [unknown, companion], adoptions: [injectedSuccess] }),
    [],
  );
});

test('webhook CANCELLED precedence suppresses missing intents, late evidence, and parent rewrites', () => {
  for (const childDay of Object.keys(conflictFixtures)) {
    const fixture = conflictFixtures[childDay];
    const normalized = normalizeOnboarding(`webhook-cancelled-${childDay.toLowerCase()}`);
    const storedUnknown = {
      ...conflictStep(normalized.onboarding_id, childDay),
      smoke_tag: normalized.smoke_tag,
    };
    const source = {
      ...normalized,
      required_steps_json: JSON.stringify([storedUnknown.step_name]),
      planned_steps_json: JSON.stringify([storedUnknown]),
      errors: [],
      child_fixtures_json: '{}',
      test_overrides_enabled: false,
      current_kickoff_slot_valid: true,
      current_kickoff_slot_start_utc: '2026-09-01T09:00:00Z',
    };
    const cancelledOlder = {
      ...parentRow(normalized.onboarding_id, 'CANCELLED', [storedUnknown.step_name]),
      smoke_tag: normalized.smoke_tag,
      blocked_reason: `older_cancelled:${childDay}`,
      updated_at_utc: '2026-01-03T00:00:00.000Z',
    };
    const cancelledLatest = {
      ...cancelledOlder,
      blocked_reason: `chosen_cancelled:${childDay}`,
      updated_at_utc: '2026-01-04T00:00:00.000Z',
    };
    const staleActive = {
      ...cancelledLatest,
      state: 'UNKNOWN_CHILD_RESULT',
      blocked_reason: 'stale_active',
      updated_at_utc: '2026-01-05T00:00:00.000Z',
    };

    for (const evidence of [fixture.success, fixture.review, fixture.deadLetter]) {
      const exactEvidence = fixture.keyedRow(storedUnknown, evidence);
      for (const storedParents of [
        [cancelledOlder, staleActive, cancelledLatest],
        [staleActive, cancelledLatest, cancelledOlder],
      ]) {
        for (let delivery = 0; delivery < 2; delivery += 1) {
          const chain = webhookChainFromStoredRows({
            source,
            steps: [storedUnknown],
            storedParents,
            nodeItems: { [fixture.webhookNode]: [exactEvidence] },
          });
          const finalParent = JSON.parse(chain.parentDecision.final_onboarding_row_json);
          const response = JSON.parse(chain.parentDecision.response_body_json);
          assert.equal(chain.claim.replay_terminal_state, 'CANCELLED', `${childDay}: claim`);
          assert.equal(JSON.parse(chain.claim.cancelled_parent_row_json).blocked_reason, `chosen_cancelled:${childDay}`, `${childDay}: chosen persisted cancellation`);
          assert.equal(chain.summary.step_intent_count, 0, `${childDay}: no intent count`);
          assert.deepEqual(JSON.parse(chain.summary.intent_rows_json), [], `${childDay}: no intent rows`);
          assert.equal(chain.summary.replay_noop, true, `${childDay}: summary replay`);
          assert.equal(chain.parentDecision.terminal_row_count, 0, `${childDay}: no terminal updates`);
          assert.deepEqual(JSON.parse(chain.parentDecision.terminal_rows_json), [], `${childDay}: no terminal rows`);
          assert.equal(chain.parentDecision.should_insert_final_onboarding, false, `${childDay}: no parent write`);
          assert.equal(chain.parentDecision.state, 'CANCELLED', `${childDay}: output state`);
          assert.equal(finalParent.state, 'CANCELLED', `${childDay}: final state`);
          assert.equal(finalParent.blocked_reason, `chosen_cancelled:${childDay}`, `${childDay}: blocked reason`);
          assert.equal(response.state, 'CANCELLED', `${childDay}: response state`);
          assert.equal(response.replay_noop, true, `${childDay}: response replay`);
        }
      }
    }
  }
});

test('webhook active scopes still adopt exact late success and roll up COMPLETE', () => {
  for (const childDay of Object.keys(conflictFixtures)) {
    const fixture = conflictFixtures[childDay];
    const normalized = normalizeOnboarding(`webhook-active-control-${childDay.toLowerCase()}`);
    const storedUnknown = {
      ...conflictStep(normalized.onboarding_id, childDay),
      smoke_tag: normalized.smoke_tag,
    };
    const active = {
      ...parentRow(normalized.onboarding_id, 'UNKNOWN_CHILD_RESULT', [storedUnknown.step_name]),
      smoke_tag: normalized.smoke_tag,
    };
    const source = {
      ...normalized,
      required_steps_json: JSON.stringify([storedUnknown.step_name]),
      planned_steps_json: JSON.stringify([storedUnknown]),
      errors: [],
      child_fixtures_json: '{}',
      test_overrides_enabled: false,
      current_kickoff_slot_valid: true,
      current_kickoff_slot_start_utc: '2026-09-01T09:00:00Z',
    };
    const chain = webhookChainFromStoredRows({
      source,
      steps: [storedUnknown],
      storedParents: [active],
      nodeItems: { [fixture.webhookNode]: [fixture.keyedRow(storedUnknown, fixture.success)] },
    });

    assert.equal(chain.claim.replay_terminal_state, 'UNKNOWN_CHILD_RESULT', childDay);
    assert.equal(chain.summary.step_intent_count, 0, childDay);
    assert.equal(chain.parentDecision.terminal_row_count, 1, childDay);
    assert.equal(JSON.parse(chain.parentDecision.terminal_rows_json)[0].state, 'TERMINAL_SUCCESS', childDay);
    assert.equal(chain.parentDecision.should_insert_final_onboarding, true, childDay);
    assert.equal(chain.parentDecision.state, 'COMPLETE', childDay);
    assert.equal(JSON.parse(chain.parentDecision.response_body_json).replay_noop, false, childDay);
  }
});

test('webhook CANCELLED suppresses missing stored steps before the intent-write branch', () => {
  const normalized = normalizeOnboarding('webhook-cancelled-missing-steps');
  const cancelled = {
    ...parentRow(normalized.onboarding_id, 'CANCELLED'),
    smoke_tag: normalized.smoke_tag,
    blocked_reason: 'cancelled_before_step_intents',
  };
  const claim = executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
    inputRows: [cancelled],
    nodeOutputs: { 'Normalize Onboarding': normalized },
  }).json;
  const summary = executeCodeNode(onboardingWorkflow, 'Build Missing Step Intent Summary', {
    inputRows: [],
    nodeOutputs: {
      'Normalize Onboarding': normalized,
      'Build Claim Decision': claim,
    },
  }).json;

  assert.equal(claim.replay_terminal_state, 'CANCELLED');
  assert.equal(summary.step_intent_count, 0);
  assert.deepEqual(JSON.parse(summary.intent_rows_json), []);
  assert.equal(summary.replay_noop, true);
});

test('webhook parent independently rejects adversarial cancellation summary and evidence', () => {
  const normalized = normalizeOnboarding('webhook-cancelled-parent-guard');
  const unknown = {
    ...conflictStep(normalized.onboarding_id, 'Invoice'),
    smoke_tag: normalized.smoke_tag,
  };
  const cancelled = {
    ...parentRow(normalized.onboarding_id, 'CANCELLED', [unknown.step_name]),
    smoke_tag: normalized.smoke_tag,
    blocked_reason: 'parent_guard_cancelled',
    updated_at_utc: '2026-01-04T00:00:00.000Z',
  };
  const staleActive = {
    ...cancelled,
    state: 'UNKNOWN_CHILD_RESULT',
    blocked_reason: 'stale_active',
    updated_at_utc: '2026-01-05T00:00:00.000Z',
  };
  const result = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': {
        ...normalized,
        required_steps_json: JSON.stringify([unknown.step_name]),
        planned_steps_json: JSON.stringify([unknown]),
        errors: [],
        child_fixtures_json: '{}',
        test_overrides_enabled: false,
      },
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: JSON.stringify([unknown]),
        intent_rows_json: JSON.stringify([{ ...unknown, step_key: 'adversarial-missing-intent' }]),
        step_intent_count: 1,
        replay_noop: false,
      },
    },
    nodeItems: {
      'Find Existing Onboarding Rows': [staleActive, cancelled],
      'Find Invoice Rows': [{
        onboarding_id: unknown.onboarding_id,
        smoke_tag: unknown.smoke_tag,
        invoice_key: unknown.predicted_child_key,
        status: 'Invoice Sent',
      }],
    },
  }).json;

  assert.equal(result.terminal_row_count, 0);
  assert.deepEqual(JSON.parse(result.terminal_rows_json), []);
  assert.equal(result.should_insert_final_onboarding, false);
  assert.equal(result.state, 'CANCELLED');
  assert.equal(JSON.parse(result.final_onboarding_row_json).blocked_reason, 'parent_guard_cancelled');
  assert.deepEqual(JSON.parse(result.response_body_json), {
    ok: false,
    onboarding_id: normalized.onboarding_id,
    state: 'CANCELLED',
    decisions: [],
    controlled_inbox: 'ops@example.com',
    replay_noop: true,
    escaped_company: cancelled.company,
  });
});

test('webhook claim chooses a stable CANCELLED snapshot when timestamps tie', () => {
  const normalized = normalizeOnboarding('webhook-cancelled-stable-tie');
  const first = {
    ...parentRow(normalized.onboarding_id, 'CANCELLED'),
    smoke_tag: normalized.smoke_tag,
    blocked_reason: 'cancelled_tie_a',
    updated_at_utc: '2026-01-04T00:00:00.000Z',
  };
  const second = {
    ...first,
    blocked_reason: 'cancelled_tie_b',
  };
  const choose = (inputRows) => executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
    inputRows,
    nodeOutputs: { 'Normalize Onboarding': normalized },
  }).json.cancelled_parent_row_json;

  const forward = choose([first, second]);
  const reverse = choose([second, first]);
  assert.equal(forward, reverse);
  assert.equal(JSON.parse(forward).state, 'CANCELLED');
});

test('CANCELLED wins stale duplicate parent permutations and repeat reconcile sweeps', () => {
  const cancelled = {
    ...parentRow('cancelled-parent-duplicates', 'CANCELLED'),
    blocked_reason: 'cancelled_by_operator',
    updated_at_utc: '2026-01-03T00:00:00.000Z',
  };
  const staleActive = {
    ...cancelled,
    state: 'UNKNOWN_CHILD_RESULT',
    blocked_reason: 'unknown_child_result',
    updated_at_utc: '2026-01-02T00:00:00.000Z',
  };
  const unknown = stepRow(cancelled.onboarding_id);
  const companion = terminalCompanion(cancelled.onboarding_id);
  const success = scopedChildRow(unknown, { invoice_key: unknown.predicted_child_key, status: 'Invoice Sent' });
  const injectedSuccess = {
    ...unknown,
    match_step_key: unknown.step_key,
    state: 'TERMINAL_SUCCESS',
    child_status: 'Invoice Sent',
    blocked_reason: '',
  };

  for (const parents of [[cancelled, staleActive], [staleActive, cancelled]]) {
    for (let sweep = 0; sweep < 2; sweep += 1) {
      const result = reconcile({ parents, steps: [unknown, companion], invoices: [success] });
      assert.equal(result.adoption_count, 0);
      assert.equal(result.parent_repair_count, 0);
      assert.equal(result.alert_count, 0);
      assert.deepEqual(adoptedRows(result), []);
      assert.deepEqual(parentRepairRows(result), []);
    }
    assert.deepEqual(
      rollup({ parents, storedSteps: [unknown, companion], adoptions: [injectedSuccess] }),
      [],
    );
  }
});

test('CANCELLED suppresses distinct duplicate step identities without repair', () => {
  const onboardingId = 'cancelled-duplicate-step-identities';
  const parent = {
    ...parentRow(onboardingId, 'CANCELLED', ['first_invoice']),
    blocked_reason: 'cancelled_by_operator',
  };
  const evidenced = duplicateInvoiceStep(onboardingId, 'a-cancelled-step', `${onboardingId}:evidenced`);
  const unproven = duplicateInvoiceStep(onboardingId, 'z-cancelled-step', `${onboardingId}:unproven`);
  const result = reconcile({
    parents: [parent],
    steps: [evidenced, unproven],
    invoices: [scopedChildRow(evidenced, { invoice_key: evidenced.predicted_child_key, status: 'Invoice Sent' })],
  });

  assert.equal(result.adoption_count, 0);
  assert.equal(result.parent_repair_count, 0);
  assert.equal(result.alert_count, 0);
  assert.deepEqual(adoptedRows(result), []);
  assert.deepEqual(parentRepairRows(result), []);
});

test('mixed reconcile batch suppresses CANCELLED scope while active scope rolls COMPLETE', () => {
  const cancelledParent = {
    ...parentRow('cancelled-mixed-batch', 'CANCELLED'),
    blocked_reason: 'cancelled_by_operator',
  };
  const activeParent = parentRow('active-mixed-batch');
  const cancelledUnknown = stepRow(cancelledParent.onboarding_id);
  const cancelledCompanion = terminalCompanion(cancelledParent.onboarding_id);
  const activeUnknown = stepRow(activeParent.onboarding_id);
  const activeCompanion = terminalCompanion(activeParent.onboarding_id);
  const storedSteps = [cancelledUnknown, cancelledCompanion, activeUnknown, activeCompanion];
  const result = reconcile({
    parents: [cancelledParent, activeParent],
    steps: storedSteps,
    invoices: [
      scopedChildRow(cancelledUnknown, { invoice_key: cancelledUnknown.predicted_child_key, status: 'Invoice Sent' }),
      scopedChildRow(activeUnknown, { invoice_key: activeUnknown.predicted_child_key, status: 'Invoice Sent' }),
    ],
  });
  const adoptions = adoptedRows(result);

  assert.equal(result.adoption_count, 1);
  assert.equal(result.parent_repair_count, 0);
  assert.deepEqual(adoptions.map((row) => row.onboarding_id), [activeParent.onboarding_id]);
  assert.deepEqual(
    rollup({ parents: [cancelledParent, activeParent], storedSteps, adoptions }).map((row) => [row.onboarding_id, row.state]),
    [[activeParent.onboarding_id, 'COMPLETE']],
  );

  const injectedCancelledSuccess = {
    ...cancelledUnknown,
    match_step_key: cancelledUnknown.step_key,
    state: 'TERMINAL_SUCCESS',
    child_status: 'Invoice Sent',
    blocked_reason: '',
  };
  assert.deepEqual(
    rollup({
      parents: [cancelledParent, activeParent],
      storedSteps,
      adoptions: [...adoptions, injectedCancelledSuccess],
    }).map((row) => [row.onboarding_id, row.state]),
    [[activeParent.onboarding_id, 'COMPLETE']],
  );
});

test('unknown without evidence remains unresolved with no adoption or parent write', () => {
  const initialParent = parentRow('no-evidence');
  const unknown = stepRow(initialParent.onboarding_id);
  const steps = [unknown, terminalCompanion(initialParent.onboarding_id)];
  const parent = rollup({ parents: [initialParent], storedSteps: steps, adoptions: [unknown] })[0];
  const result = reconcile({ parents: [parent], steps });
  assert.equal(result.adoption_count, 0);
  assert.equal(result.parent_repair_count, 0);
  assert.equal(result.rechecked_unknown_count, 1);
  assert.equal(result.unresolved_unknown_count, 1);
  assert.deepEqual(adoptedRows(result), []);
  assert.deepEqual(parentRepairRows(result), []);
  assert.deepEqual(rollup({ parents: [parent], storedSteps: steps, adoptions: [] }), []);
});

test('reconcile alerts once when document or kickoff wait steps cross 24 hours', () => {
  const hoursAgo = (hours) => new Date(Date.now() - hours * 36e5).toISOString();
  for (const fixture of [
    {
      state: 'DOC_WAITING_UPLOAD',
      stepName: 'signed_document',
      childDay: 'Document',
      bucket: 'missing_doc_24h',
    },
    {
      state: 'KICKOFF_SLOT_MISSING',
      stepName: 'kickoff_booking',
      childDay: 'Booking',
      bucket: 'missing_slot_24h',
    },
  ]) {
    const onboardingId = `wait-${fixture.stepName}`;
    const agedAt = hoursAgo(24.25);
    const agedStep = stepRow(onboardingId, {
      step_name: fixture.stepName,
      child_day: fixture.childDay,
      state: fixture.state,
      created_at_utc: agedAt,
      updated_at_utc: agedAt,
      last_progress_at_utc: agedAt,
      blocked_reason: fixture.state.toLowerCase(),
    });
    const aged = reconcile({ parents: [], steps: [agedStep] });
    const emitted = JSON.parse(aged.alert_rows_json);

    assert.equal(aged.alert_count, 1, fixture.state);
    assert.equal(emitted.length, 1, fixture.state);
    assert.equal(emitted[0].age_bucket, fixture.bucket);
    assert.equal(emitted[0].alert_type, 'stranded_onboarding');
    assert.equal(emitted[0].onboarding_id, onboardingId);
    assert.equal(emitted[0].step_key, agedStep.step_key);
    assert.equal(aged.adoption_count, 0);
    assert.deepEqual(adoptedRows(aged), []);

    const parent = {
      ...parentRow(onboardingId, fixture.state, [fixture.stepName]),
      created_at_utc: agedAt,
      updated_at_utc: agedAt,
      last_progress_at_utc: agedAt,
    };
    const withParent = reconcile({ parents: [parent], steps: [agedStep] });
    const parentScopedAlerts = JSON.parse(withParent.alert_rows_json);
    assert.equal(withParent.alert_count, 1, `${fixture.state}:parent duplicate`);
    assert.equal(parentScopedAlerts[0].step_key, agedStep.step_key);
    assert.equal(withParent.adoption_count, 0);

    const recentAt = hoursAgo(23.75);
    const recent = reconcile({
      parents: [],
      steps: [{
        ...agedStep,
        created_at_utc: recentAt,
        updated_at_utc: recentAt,
        last_progress_at_utc: recentAt,
      }],
    });
    assert.equal(recent.alert_count, 0, fixture.state);
    assert.equal(recent.adoption_count, 0, fixture.state);

    const replay = reconcile({
      parents: [],
      steps: [agedStep],
      alerts: [{ ...emitted[0], throttle_consumed: true }],
    });
    assert.equal(replay.alert_count, 0, fixture.state);
    assert.equal(replay.adoption_count, 0, fixture.state);
    assert.deepEqual(adoptedRows(replay), []);
  }
});

test('reconcile alert throttles are unique within and isolated across run tags', () => {
  const agedAt = new Date(Date.now() - 24.25 * 36e5).toISOString();
  const normal = stepRow('shared-alert-owner', {
    step_name: 'signed_document',
    child_day: 'Document',
    state: 'DOC_WAITING_UPLOAD',
    smoke_tag: 'ONBOARDING-DRAFT',
    created_at_utc: agedAt,
    updated_at_utc: agedAt,
    last_progress_at_utc: agedAt,
  });
  const fixture = { ...normal, smoke_tag: '  TEST-FIX-ALERT  ' };

  const duplicate = reconcile({ parents: [], steps: [normal, { ...normal }] });
  assert.equal(duplicate.alert_count, 1);
  assert.equal(duplicate.adoption_count, 0);
  assert.deepEqual(adoptedRows(duplicate), []);

  const crossTag = reconcile({ parents: [], steps: [normal, fixture] });
  const crossTagAlerts = JSON.parse(crossTag.alert_rows_json);
  assert.equal(crossTag.alert_count, 2);
  assert.equal(crossTag.adoption_count, 0);
  assert.equal(new Set(crossTagAlerts.map((row) => row.alert_key)).size, 2);
  assert.deepEqual(
    crossTagAlerts.map((row) => row.smoke_tag).sort(),
    ['ONBOARDING-DRAFT', 'TEST-FIX-ALERT'],
  );
  assert.ok(crossTagAlerts.every((row) => row.onboarding_id === normal.onboarding_id));
  assert.ok(crossTagAlerts.every((row) => row.step_key === normal.step_key));

  const consumedNormal = crossTagAlerts.find((row) => row.smoke_tag === 'ONBOARDING-DRAFT');
  const fixtureAfterNormalConsumed = reconcile({
    parents: [],
    steps: [fixture],
    alerts: [{ ...consumedNormal, throttle_consumed: true }],
  });
  const fixtureAlerts = JSON.parse(fixtureAfterNormalConsumed.alert_rows_json);
  assert.equal(fixtureAfterNormalConsumed.alert_count, 1);
  assert.equal(fixtureAfterNormalConsumed.adoption_count, 0);
  assert.equal(fixtureAlerts[0].smoke_tag, 'TEST-FIX-ALERT');
  assert.notEqual(fixtureAlerts[0].alert_key, consumedNormal.alert_key);
  assert.deepEqual(adoptedRows(fixtureAfterNormalConsumed), []);
});

test('alert throttle is consumed only by a provider-shaped Gmail confirmation', () => {
  const intent = {
    id: 'datatable-row-id-42',
    alert_key: 'alert-key-42',
    send_status: 'INTENT_WRITTEN',
    throttle_consumed: false,
    last_execution_id: 'alert-execution',
  };
  const passedThroughIntent = executeCodeNode(onboardingWorkflow, 'Build Alert Sent Update', {
    input: intent,
    nodeOutputs: { 'Insert Reconcile Alert Intent Rows': intent },
  });
  assert.deepEqual(passedThroughIntent, []);

  const missingThread = executeCodeNode(onboardingWorkflow, 'Build Alert Sent Update', {
    input: { id: 'gmail-message-id' },
    nodeOutputs: { 'Insert Reconcile Alert Intent Rows': intent },
  });
  assert.deepEqual(missingThread, []);

  const confirmed = executeCodeNode(onboardingWorkflow, 'Build Alert Sent Update', {
    input: { id: 'gmail-message-id', threadId: 'gmail-thread-id' },
    nodeOutputs: { 'Insert Reconcile Alert Intent Rows': intent },
  }).json;
  assert.equal(confirmed.alert_key, intent.alert_key);
  assert.equal(confirmed.send_status, 'SENT_CONTROLLED');
  assert.equal(confirmed.throttle_consumed, true);
  assert.equal(confirmed.last_execution_id, intent.last_execution_id);

  const workflow = loadWorkflow(onboardingWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  const insertName = 'Insert Reconcile Alert Intent Rows';
  const gmailName = 'Send Controlled Reconcile Alert';
  assert.equal(nodesByName.get(insertName).onError, 'stopWorkflow');
  assert.equal(nodesByName.get(gmailName).onError, 'stopWorkflow');
  assert.deepEqual(Object.keys(workflow.connections[insertName]), ['main']);
  assert.deepEqual(Object.keys(workflow.connections[gmailName]), ['main']);
  assert.deepEqual(next(insertName), [gmailName]);
  assert.deepEqual(next(gmailName), ['Build Alert Sent Update']);
  assert.deepEqual(next('Build Alert Sent Update'), ['Update Reconcile Alert Sent']);
});

test('reconcile alert throttle lookup fails closed before Build UTC and Gmail', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const lookupName = 'Find Existing Reconcile Alert Rows';
  const buildName = 'Build UTC Reconcile Alerts';
  const insertName = 'Insert Reconcile Alert Intent Rows';
  const gmailName = 'Send Controlled Reconcile Alert';
  const lookupNode = nodesByName.get(lookupName);
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  const reaches = (start, target) => {
    const seen = new Set();
    const queue = [...next(start)];
    while (queue.length) {
      const name = queue.shift();
      if (name === target) return true;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...next(name));
    }
    return false;
  };
  const agedAt = new Date(Date.now() - 24.25 * 36e5).toISOString();
  const agedStep = stepRow('alert-lookup-fail-closed', {
    step_name: 'signed_document',
    child_day: 'Document',
    state: 'DOC_WAITING_UPLOAD',
    created_at_utc: agedAt,
    updated_at_utc: agedAt,
    last_progress_at_utc: agedAt,
  });
  const simulateLookup = ({ readFailed, storedAlerts }) => {
    const stopped = readFailed && lookupNode.onError === 'stopWorkflow';
    if (stopped) {
      return {
        executionFailed: true,
        buildExecutionCount: 0,
        alertCount: 0,
        alertKeys: [],
        insertReachable: false,
        gmailReachable: false,
      };
    }

    // n8n 2.33.3 passes the parent item on regular output when this lookup fails.
    // alwaysOutputData supplies one empty item for a healthy, legitimate zero-row read.
    const lookupOutput = readFailed ? [{}] : storedAlerts;
    const built = reconcile({ parents: [], steps: [agedStep], alerts: lookupOutput });
    const alertRows = JSON.parse(built.alert_rows_json);
    return {
      executionFailed: false,
      buildExecutionCount: 1,
      alertCount: built.alert_count,
      alertKeys: alertRows.map((row) => row.alert_key),
      insertReachable: built.alert_count > 0 && reaches(buildName, insertName),
      gmailReachable: built.alert_count > 0 && reaches(buildName, gmailName),
    };
  };

  assert.deepEqual(next('Find Reconcile Onboarding Rows'), [lookupName]);
  assert.deepEqual(next(lookupName), ['Find Reconcile Step Rows']);
  assert.ok(reaches(lookupName, buildName));
  assert.ok(reaches(buildName, insertName));
  assert.ok(reaches(buildName, gmailName));
  assert.equal(lookupNode.alwaysOutputData, true);
  const errorBypassTargets = Object.entries(workflow.connections[lookupName] || {})
    .filter(([output]) => output !== 'main')
    .flatMap(([, channels]) => (channels || []).flat().map((edge) => edge.node));
  assert.deepEqual(errorBypassTargets, []);

  const healthyEmpty = simulateLookup({ readFailed: false, storedAlerts: [] });
  assert.equal(healthyEmpty.executionFailed, false);
  assert.equal(healthyEmpty.buildExecutionCount, 1);
  assert.equal(healthyEmpty.alertCount, 1);
  assert.equal(healthyEmpty.insertReachable, true);
  assert.equal(healthyEmpty.gmailReachable, true);

  const consumed = {
    ...JSON.parse(reconcile({ parents: [], steps: [agedStep] }).alert_rows_json)[0],
    throttle_consumed: true,
  };
  const healthyConsumed = simulateLookup({ readFailed: false, storedAlerts: [consumed] });
  assert.equal(healthyConsumed.alertCount, 0);
  assert.deepEqual(healthyConsumed.alertKeys, []);
  assert.equal(healthyConsumed.insertReachable, false);
  assert.equal(healthyConsumed.gmailReachable, false);

  const failedLookup = simulateLookup({ readFailed: true, storedAlerts: [consumed] });
  if (!failedLookup.executionFailed) {
    assert.equal(failedLookup.alertCount, 1);
    assert.deepEqual(failedLookup.alertKeys, healthyEmpty.alertKeys);
    assert.equal(failedLookup.insertReachable, true);
    assert.equal(failedLookup.gmailReachable, true);
  }
  assert.deepEqual(failedLookup, {
    executionFailed: true,
    buildExecutionCount: 0,
    alertCount: 0,
    alertKeys: [],
    insertReachable: false,
    gmailReachable: false,
  });
  assert.equal(lookupNode.onError, 'stopWorkflow');
});

const reconcileSnapshotSources = [
  'Find Reconcile Onboarding Rows',
  'Find Reconcile Step Rows',
  'Find Reconcile Offer Rows',
  'Find Reconcile Invoice Rows',
  'Find Reconcile Booking Rows',
  'Find Reconcile Document Rows',
];

function reconcileSummaryRow(step) {
  return {
    onboarding_id: step.onboarding_id,
    step_key: step.step_key,
    step_name: step.step_name,
    state: step.state,
    status: step.child_status || '',
    predicted_child_key: step.predicted_child_key || '',
  };
}

function executeReconcileSnapshot(nodeItems) {
  const built = executeCodeNode(onboardingWorkflow, 'Build UTC Reconcile Alerts', { nodeItems }).json;
  const alertRows = JSON.parse(built.alert_rows_json);
  const emittedRows = built.adoption_count + built.parent_repair_count > 0
    ? executeCodeNode(onboardingWorkflow, 'Emit Reconcile Adopted Step Rows', { input: built }).map((item) => item.json)
    : [];
  const parentRows = emittedRows.length > 0
    ? executeCodeNode(onboardingWorkflow, 'Build Reconcile Parent Rollups', {
      inputRows: emittedRows,
      nodeItems: {
        'Find Reconcile Onboarding Rows': nodeItems['Find Reconcile Onboarding Rows'],
        'Find Reconcile Step Rows': nodeItems['Find Reconcile Step Rows'],
      },
    })
    : [];
  return {
    executionFailed: false,
    buildExecutionCount: 1,
    alertCount: built.alert_count,
    gmailCount: alertRows.length,
    adoptionCount: built.adoption_count,
    repairCount: built.parent_repair_count,
    stepWriteCount: emittedRows.length,
    parentWriteCount: parentRows.length,
    parentRows: parentRows.map((item) => JSON.parse(item.json.final_onboarding_row_json)),
  };
}

function stoppedReconcileSnapshot() {
  return {
    executionFailed: true,
    buildExecutionCount: 0,
    alertCount: 0,
    gmailCount: 0,
    adoptionCount: 0,
    repairCount: 0,
    stepWriteCount: 0,
    parentWriteCount: 0,
    parentRows: [],
  };
}

function reconcileSnapshotFixture(sourceName) {
  const now = new Date().toISOString();
  const agedAt = new Date(Date.now() - 8 * 24 * 36e5).toISOString();
  const sourceSuffix = sourceName.replace(/^Find Reconcile | Rows$/g, '').toLowerCase().replaceAll(' ', '-');

  if (sourceName === 'Find Reconcile Onboarding Rows') {
    const onboardingId = `snapshot-failure-${sourceSuffix}`;
    const parent = {
      ...parentRow(onboardingId, 'CANCELLED', ['first_invoice', 'signed_document']),
      blocked_reason: 'cancelled_by_operator',
    };
    const invoiceStep = {
      ...conflictStep(onboardingId, 'Invoice'),
      created_at_utc: now,
      updated_at_utc: now,
      last_progress_at_utc: now,
    };
    const waitingStep = stepRow(onboardingId, {
      step_name: 'signed_document',
      child_day: 'Document',
      state: 'DOC_WAITING_UPLOAD',
      predicted_child_key: `document-${onboardingId}`,
      child_status: 'document_waiting_upload',
      blocked_reason: 'document_waiting_upload',
      created_at_utc: agedAt,
      updated_at_utc: agedAt,
      last_progress_at_utc: agedAt,
    });
    return {
      nodeItems: {
        'Find Reconcile Onboarding Rows': [parent],
        'Find Existing Reconcile Alert Rows': [{}],
        'Find Reconcile Step Rows': [invoiceStep, waitingStep],
        'Find Reconcile Offer Rows': [{}],
        'Find Reconcile Invoice Rows': [conflictFixtures.Invoice.keyedRow(invoiceStep, conflictFixtures.Invoice.success)],
        'Find Reconcile Booking Rows': [{}],
        'Find Reconcile Document Rows': [{}],
      },
      passThroughRows: [{ timestamp: now }],
      healthy: { alertCount: 0, adoptionCount: 0, repairCount: 0, stepWriteCount: 0, parentWriteCount: 0 },
      assertCurrentFailureRisk: (result) => {
        assert.ok(result.alertCount > 0, 'hidden cancellation emits a false alert');
        assert.equal(result.adoptionCount, 1, 'hidden cancellation permits a false adoption');
        assert.ok(result.stepWriteCount > 0, 'hidden cancellation reaches the step writer');
      },
    };
  }

  if (sourceName === 'Find Reconcile Step Rows') {
    const onboardingId = `snapshot-failure-${sourceSuffix}`;
    const storedStep = {
      ...terminalCompanion(onboardingId),
      created_at_utc: now,
      updated_at_utc: now,
      last_progress_at_utc: now,
    };
    const parent = {
      ...parentRow(onboardingId, 'COMPLETE', [storedStep.step_name]),
      blocked_reason: '',
      step_summary_json: JSON.stringify([reconcileSummaryRow(storedStep)]),
    };
    const agedWaitingStep = stepRow(onboardingId, {
      step_name: 'signed_document',
      child_day: 'Document',
      state: 'DOC_WAITING_UPLOAD',
      predicted_child_key: `document-${onboardingId}`,
      child_status: 'document_waiting_upload',
      blocked_reason: 'document_waiting_upload',
      created_at_utc: agedAt,
      updated_at_utc: agedAt,
      last_progress_at_utc: agedAt,
    });
    const alertRow = JSON.parse(reconcile({ parents: [], steps: [agedWaitingStep] }).alert_rows_json)[0];
    return {
      nodeItems: {
        'Find Reconcile Onboarding Rows': [parent],
        'Find Existing Reconcile Alert Rows': [alertRow],
        'Find Reconcile Step Rows': [storedStep],
        'Find Reconcile Offer Rows': [{}],
        'Find Reconcile Invoice Rows': [{}],
        'Find Reconcile Booking Rows': [{}],
        'Find Reconcile Document Rows': [{}],
      },
      passThroughRows: [alertRow],
      healthy: { alertCount: 0, adoptionCount: 0, repairCount: 0, stepWriteCount: 0, parentWriteCount: 0 },
      assertCurrentFailureRisk: (result) => {
        assert.equal(result.repairCount, 1, 'alert lookup item is misread as a step and triggers repair');
        assert.equal(result.stepWriteCount, 1, 'malformed repair reaches the step writer');
        assert.equal(result.parentWriteCount, 1, 'malformed summary reaches the parent writer');
        assert.equal(result.parentRows[0].step_summary_json.includes('welcome_email'), false);
      },
    };
  }

  const childDay = sourceName.match(/^Find Reconcile (Offer|Invoice|Booking|Document) Rows$/)[1];
  const fixture = conflictFixtures[childDay];
  const onboardingId = `snapshot-failure-${sourceSuffix}`;
  const unknownStep = {
    ...conflictStep(onboardingId, childDay),
    state: 'INTENT_WRITTEN',
    child_status: '',
    child_proof_json: '',
    blocked_reason: '',
    created_at_utc: agedAt,
    updated_at_utc: agedAt,
    last_progress_at_utc: agedAt,
  };
  const adoptedStep = {
    ...unknownStep,
    state: 'TERMINAL_SUCCESS',
    child_status: fixture.success.status,
    blocked_reason: '',
  };
  const parent = {
    ...parentRow(onboardingId, 'COMPLETE', [unknownStep.step_name]),
    blocked_reason: '',
    step_summary_json: JSON.stringify([reconcileSummaryRow(adoptedStep)]),
  };
  const fieldName = fixture.reconcileField === 'offers'
    ? 'Find Reconcile Offer Rows'
    : (fixture.reconcileField === 'invoices'
      ? 'Find Reconcile Invoice Rows'
      : (fixture.reconcileField === 'bookings' ? 'Find Reconcile Booking Rows' : 'Find Reconcile Document Rows'));
  const nodeItems = {
    'Find Reconcile Onboarding Rows': [parent],
    'Find Existing Reconcile Alert Rows': [{}],
    'Find Reconcile Step Rows': [unknownStep],
    'Find Reconcile Offer Rows': [{}],
    'Find Reconcile Invoice Rows': [{}],
    'Find Reconcile Booking Rows': [{}],
    'Find Reconcile Document Rows': [{}],
  };
  nodeItems[fieldName] = [fixture.keyedRow(unknownStep, fixture.success)];
  return {
    nodeItems,
    passThroughRows: sourceName === 'Find Reconcile Offer Rows' ? [unknownStep] : [{}],
    healthy: { alertCount: 0, adoptionCount: 1, repairCount: 0, stepWriteCount: 1, parentWriteCount: 1 },
    assertCurrentFailureRisk: (result) => {
      assert.ok(result.alertCount > 0, `${childDay} failure emits a false stalled alert`);
      assert.equal(result.adoptionCount, 0, `${childDay} failure hides healthy evidence`);
      assert.equal(result.repairCount, 1, `${childDay} failure emits a false parent repair`);
      assert.equal(result.stepWriteCount, 1, `${childDay} failure reaches the step writer`);
      assert.equal(result.parentWriteCount, 1, `${childDay} failure reaches the parent writer`);
    },
  };
}

for (const sourceName of reconcileSnapshotSources) {
  test(`${sourceName} failure stops the incomplete reconcile snapshot before Build UTC`, () => {
    const workflow = loadWorkflow(onboardingWorkflow);
    const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
    const sourceNode = nodesByName.get(sourceName);
    const fixture = reconcileSnapshotFixture(sourceName);
    const healthy = executeReconcileSnapshot(fixture.nodeItems);
    const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
    const reaches = (start, target) => {
      const seen = new Set();
      const queue = [...next(start)];
      while (queue.length) {
        const name = queue.shift();
        if (name === target) return true;
        if (seen.has(name)) continue;
        seen.add(name);
        queue.push(...next(name));
      }
      return false;
    };
    const errorBypassTargets = Object.entries(workflow.connections[sourceName] || {})
      .filter(([output]) => output !== 'main')
      .flatMap(([, channels]) => (channels || []).flat().map((edge) => edge.node));

    assert.deepEqual({
      alertCount: healthy.alertCount,
      adoptionCount: healthy.adoptionCount,
      repairCount: healthy.repairCount,
      stepWriteCount: healthy.stepWriteCount,
      parentWriteCount: healthy.parentWriteCount,
    }, fixture.healthy);
    assert.equal(sourceNode.alwaysOutputData, true);
    assert.ok(reaches(sourceName, 'Build UTC Reconcile Alerts'));
    assert.deepEqual(errorBypassTargets, []);

    const failedNodeItems = { ...fixture.nodeItems, [sourceName]: fixture.passThroughRows };
    const failed = sourceNode.onError === 'stopWorkflow'
      ? stoppedReconcileSnapshot()
      : executeReconcileSnapshot(failedNodeItems);
    if (!failed.executionFailed) fixture.assertCurrentFailureRisk(failed);
    assert.deepEqual(failed, stoppedReconcileSnapshot());
    assert.equal(sourceNode.onError, 'stopWorkflow');
  });
}

test('a successful empty reconcile snapshot still reaches Build UTC without child resend', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const emptyNodeItems = {
    'Find Reconcile Onboarding Rows': [{}],
    'Find Existing Reconcile Alert Rows': [{}],
    'Find Reconcile Step Rows': [{}],
    'Find Reconcile Offer Rows': [{}],
    'Find Reconcile Invoice Rows': [{}],
    'Find Reconcile Booking Rows': [{}],
    'Find Reconcile Document Rows': [{}],
  };
  const result = executeReconcileSnapshot(emptyNodeItems);
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  const reachable = new Set();
  const queue = ['UTC Reconcile Sweep'];
  while (queue.length) {
    const name = queue.shift();
    if (reachable.has(name)) continue;
    reachable.add(name);
    queue.push(...next(name));
  }

  assert.deepEqual(result, {
    executionFailed: false,
    buildExecutionCount: 1,
    alertCount: 0,
    gmailCount: 0,
    adoptionCount: 0,
    repairCount: 0,
    stepWriteCount: 0,
    parentWriteCount: 0,
    parentRows: [],
  });
  assert.ok(reachable.has('Build UTC Reconcile Alerts'));
  assert.equal([...reachable].some((name) => nodesByName.get(name)?.type === 'n8n-nodes-base.executeWorkflow'), false);
  for (const sourceName of reconcileSnapshotSources) {
    assert.equal(nodesByName.get(sourceName).alwaysOutputData, true);
  }
});

test('reconcile alert receipt update failure is visible and a confirmed receipt consumes once', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const updateName = 'Update Reconcile Alert Sent';
  const updateNode = nodesByName.get(updateName);
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  const errorBypassTargets = Object.entries(workflow.connections[updateName] || {})
    .filter(([output]) => output !== 'main')
    .flatMap(([, channels]) => (channels || []).flat().map((edge) => edge.node));
  const agedAt = new Date(Date.now() - 24.25 * 36e5).toISOString();
  const agedStep = stepRow('alert-receipt-fail-closed', {
    step_name: 'signed_document',
    child_day: 'Document',
    state: 'DOC_WAITING_UPLOAD',
    created_at_utc: agedAt,
    updated_at_utc: agedAt,
    last_progress_at_utc: agedAt,
  });
  const firstSweep = reconcile({ parents: [], steps: [agedStep] });
  const intent = JSON.parse(firstSweep.alert_rows_json)[0];
  const confirmed = executeCodeNode(onboardingWorkflow, 'Build Alert Sent Update', {
    input: { id: 'gmail-message-id', threadId: 'gmail-thread-id' },
    nodeOutputs: { 'Insert Reconcile Alert Intent Rows': intent },
  }).json;
  const simulateReceiptUpdateFailure = () => {
    const stopped = updateNode.onError === 'stopWorkflow';
    return {
      executionFailed: stopped,
      silentlyCompleted: !stopped,
    };
  };

  assert.equal(firstSweep.alert_count, 1);
  assert.equal(confirmed.alert_key, intent.alert_key);
  assert.equal(confirmed.throttle_consumed, true);
  assert.equal(confirmed.send_status, 'SENT_CONTROLLED');
  assert.deepEqual(next('Build Alert Sent Update'), [updateName]);
  assert.deepEqual(next(updateName), []);
  assert.deepEqual(errorBypassTargets, []);
  assert.deepEqual(simulateReceiptUpdateFailure(), {
    executionFailed: true,
    silentlyCompleted: false,
  });
  assert.equal(updateNode.onError, 'stopWorkflow');

  const afterSuccessfulUpdate = reconcile({ parents: [], steps: [agedStep], alerts: [confirmed] });
  const repeatedSweep = reconcile({ parents: [], steps: [agedStep], alerts: [confirmed] });
  assert.equal(afterSuccessfulUpdate.alert_count, 0);
  assert.equal(repeatedSweep.alert_count, 0);
  assert.deepEqual(JSON.parse(afterSuccessfulUpdate.alert_rows_json), []);
  assert.deepEqual(JSON.parse(repeatedSweep.alert_rows_json), []);
});

test('one owner-bound Filed document adopts exactly one same-file onboarding and writes only that parent', () => {
  const normalizedA = normalizeOnboarding('same-file-owner-a');
  const normalizedB = normalizeOnboarding('same-file-owner-b');
  const plannedA = plannedStep(normalizedA, 'signed_document');
  const plannedB = plannedStep(normalizedB, 'signed_document');
  const unknownA = stepRow(normalizedA.onboarding_id, {
    ...plannedA,
    state: 'UNKNOWN_CHILD_RESULT',
    child_status: 'no_terminal_child_row',
    child_proof_json: JSON.stringify({ retry_legal: false, reason: 'missing_child_table_evidence' }),
    blocked_reason: 'no_terminal_child_row',
  });
  const unknownB = stepRow(normalizedB.onboarding_id, {
    ...plannedB,
    state: 'UNKNOWN_CHILD_RESULT',
    child_status: 'no_terminal_child_row',
    child_proof_json: JSON.stringify({ retry_legal: false, reason: 'missing_child_table_evidence' }),
    blocked_reason: 'no_terminal_child_row',
  });
  assert.notEqual(unknownA.predicted_child_key, unknownB.predicted_child_key);
  const child = normalizeDocument(JSON.parse(unknownA.request_snapshot_bytes));
  const documentRow = { document_key: child.document_key, onboarding_id: child.onboarding_id, smoke_tag: child.smoke_tag, status: 'Filed' };
  const parentA = { ...parentRow(normalizedA.onboarding_id, 'UNKNOWN_CHILD_RESULT', ['signed_document', 'welcome_email']), smoke_tag: normalizedA.smoke_tag };
  const parentB = { ...parentRow(normalizedB.onboarding_id, 'UNKNOWN_CHILD_RESULT', ['signed_document', 'welcome_email']), smoke_tag: normalizedB.smoke_tag };
  const storedSteps = [
    unknownA,
    { ...terminalCompanion(normalizedA.onboarding_id), smoke_tag: normalizedA.smoke_tag },
    unknownB,
    { ...terminalCompanion(normalizedB.onboarding_id), smoke_tag: normalizedB.smoke_tag },
  ];

  const result = reconcile({ parents: [parentA, parentB], steps: storedSteps, documents: [documentRow] });
  const adoptions = adoptedRows(result);
  assert.equal(result.adoption_count, 1);
  assert.equal(adoptions[0].step_key, unknownA.step_key);
  assert.equal(adoptions[0].state, 'TERMINAL_SUCCESS');
  assert.equal(unknownB.state, 'UNKNOWN_CHILD_RESULT');
  assert.equal(JSON.parse(unknownB.child_proof_json).retry_legal, false);
  assert.equal(adoptions.some((row) => row.step_key === unknownB.step_key), false);

  const writtenParents = rollup({ parents: [parentA, parentB], storedSteps, adoptions });
  assert.equal(writtenParents.length, 1);
  assert.equal(writtenParents[0].onboarding_id, normalizedA.onboarding_id);
  assert.equal(writtenParents[0].state, 'COMPLETE');
});

test('missing or mismatched document owner adopts no step and writes no parent', () => {
  const normalized = normalizeOnboarding('owner-check-reconcile');
  const planned = plannedStep(normalized, 'signed_document');
  const unknown = stepRow(normalized.onboarding_id, {
    ...planned,
    state: 'UNKNOWN_CHILD_RESULT',
    child_status: 'no_terminal_child_row',
    child_proof_json: JSON.stringify({ retry_legal: false, reason: 'missing_child_table_evidence' }),
    blocked_reason: 'no_terminal_child_row',
  });
  const parent = parentRow(normalized.onboarding_id, 'UNKNOWN_CHILD_RESULT', ['signed_document', 'welcome_email']);
  const storedSteps = [unknown, terminalCompanion(normalized.onboarding_id)];
  for (const documentRow of [
    { document_key: unknown.predicted_child_key, status: 'Filed' },
    { document_key: unknown.predicted_child_key, onboarding_id: 'f'.repeat(64), status: 'Filed' },
  ]) {
    const result = reconcile({ parents: [parent], steps: storedSteps, documents: [documentRow] });
    assert.equal(result.adoption_count, 0);
    assert.equal(result.unresolved_unknown_count, 1);
    assert.deepEqual(adoptedRows(result), []);
    assert.deepEqual(rollup({ parents: [parent], storedSteps, adoptions: [] }), []);
    assert.equal(JSON.parse(unknown.child_proof_json).retry_legal, false);
  }
});

test('webhook parent decisions reject offer and document evidence with a missing or mismatched owner', () => {
  const normalized = normalizeOnboarding('owner-check-webhook');
  for (const fixture of [
    { stepName: 'offer_out', nodeName: 'Find Offer Rows', keyName: 'submission_id', success: { email_sent: true } },
    { stepName: 'signed_document', nodeName: 'Find Document Rows', keyName: 'document_key', success: { status: 'Filed' } },
  ]) {
    const planned = plannedStep(normalized, fixture.stepName);
    const unknown = {
      ...planned,
      state: 'UNKNOWN_CHILD_RESULT',
      child_status: 'no_terminal_child_row',
      child_proof_json: JSON.stringify({ retry_legal: false, reason: 'missing_child_table_evidence' }),
      blocked_reason: 'no_terminal_child_row',
    };
    for (const owner of [undefined, 'e'.repeat(64)]) {
      const row = { [fixture.keyName]: unknown.predicted_child_key, ...fixture.success };
      if (owner !== undefined) row.onboarding_id = owner;
      const result = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
        nodeOutputs: {
          'Normalize Onboarding': { ...normalized, planned_steps_json: JSON.stringify([unknown]) },
          'Build Missing Step Intent Summary': {
            existing_step_rows_json: JSON.stringify([unknown]),
            intent_rows_json: '[]',
            replay_noop: false,
          },
        },
        nodeItems: { [fixture.nodeName]: [row] },
      }).json;
      const decision = JSON.parse(result.response_body_json).decisions[0];
      assert.equal(decision.state, 'UNKNOWN_CHILD_RESULT', `${fixture.stepName}:${owner}`);
      assert.equal(result.terminal_row_count, 0, `${fixture.stepName}:${owner}`);
      assert.equal(JSON.parse(unknown.child_proof_json).retry_legal, false);
    }
  }
});

test('late review and dead-letter evidence produce the correct parent states', () => {
  const reviewParent = parentRow('late-review', 'UNKNOWN_CHILD_RESULT', ['signed_document', 'welcome_email']);
  const deadParent = parentRow('late-dead');
  const reviewStep = stepRow(reviewParent.onboarding_id, {
    child_day: 'Document',
    step_name: 'signed_document',
    predicted_child_key: 'doc-review-key',
  });
  const deadStep = stepRow(deadParent.onboarding_id, { predicted_child_key: 'invoice-dead-key' });
  const storedSteps = [
    reviewStep,
    terminalCompanion(reviewParent.onboarding_id),
    deadStep,
    terminalCompanion(deadParent.onboarding_id),
  ];
  const result = reconcile({
    parents: [reviewParent, deadParent],
    steps: storedSteps,
    documents: [scopedChildRow(reviewStep, { document_key: reviewStep.predicted_child_key, status: 'Needs Review' })],
    invoices: [scopedChildRow(deadStep, { invoice_key: deadStep.predicted_child_key, status: 'Dead Letter' })],
  });
  const adoptions = adoptedRows(result);
  assert.deepEqual(adoptions.map((row) => row.state).sort(), ['TERMINAL_DEAD_LETTER', 'TERMINAL_REVIEW']);
  const rolled = rollup({ parents: [reviewParent, deadParent], storedSteps, adoptions });
  const byId = new Map(rolled.map((row) => [row.onboarding_id, row]));
  assert.equal(byId.get(reviewParent.onboarding_id).state, 'HUMAN_REQUIRED');
  assert.equal(byId.get(deadParent.onboarding_id).state, 'PARTIAL_BLOCKED');
  assert.match(byId.get(deadParent.onboarding_id).blocked_reason, /first_invoice:dead_letter/i);
});

test('Filed plus Needs Review document evidence is permutation-invariant in webhook, reconcile, and parent rollup', () => {
  const step = conflictStep('document-da-permutation', 'Document');
  const fixture = conflictFixtures.Document;
  const success = fixture.keyedRow(step, { ...fixture.success, sensitive_note: 'must-not-enter-proof' });
  const review = fixture.keyedRow(step, { ...fixture.review, sensitive_note: 'also-private' });
  const permutations = [[success, review], [review, success]];
  const webhook = permutations.map((rows) => webhookEvidenceDecision(step, rows));
  const reconciled = permutations.map((rows) => reconcileEvidenceDecision(step, rows));

  assert.deepEqual(webhook[0], webhook[1]);
  assert.deepEqual(reconciled[0], reconciled[1]);
  for (const decision of [...webhook, ...reconciled]) {
    assert.equal(decision.state, 'TERMINAL_REVIEW');
    assert.equal(decision.parentState, 'HUMAN_REQUIRED');
    assert.equal(decision.proof.retry_legal, false);
    assert.equal(decision.proof.evidence_match_count, 2);
    assert.deepEqual(decision.proof.evidence_classifications, ['TERMINAL_REVIEW:1', 'TERMINAL_SUCCESS:1']);
    assert.doesNotMatch(JSON.stringify(decision.proof), /must-not-enter-proof|also-private/);
  }
});

test('all child evidence conflicts use the same fail-closed precedence independent of row order', () => {
  for (const childDay of Object.keys(conflictFixtures)) {
    const fixture = conflictFixtures[childDay];
    const step = conflictStep(`matrix-${childDay.toLowerCase()}`, childDay);
    for (const conflict of [
      { label: 'review', row: fixture.review, state: 'TERMINAL_REVIEW', parentState: 'HUMAN_REQUIRED' },
      { label: 'dead-letter', row: fixture.deadLetter, state: 'TERMINAL_DEAD_LETTER', parentState: 'PARTIAL_BLOCKED' },
    ]) {
      const success = fixture.keyedRow(step, fixture.success);
      const blocker = fixture.keyedRow(step, conflict.row);
      for (const run of [webhookEvidenceDecision, reconcileEvidenceDecision]) {
        const forward = run(step, [success, blocker]);
        const reverse = run(step, [blocker, success]);
        assert.deepEqual(forward, reverse, `${childDay}:${conflict.label}:${run.name}`);
        assert.equal(forward.state, conflict.state, `${childDay}:${conflict.label}:${run.name}`);
        assert.equal(forward.parentState, conflict.parentState, `${childDay}:${conflict.label}:${run.name}`);
        assert.equal(forward.proof.retry_legal, false, `${childDay}:${conflict.label}:${run.name}`);
        assert.equal(forward.proof.evidence_match_count, 2, `${childDay}:${conflict.label}:${run.name}`);
        assert.deepEqual(
          forward.proof.evidence_classifications,
          [`${conflict.state}:1`, 'TERMINAL_SUCCESS:1'].sort(),
          `${childDay}:${conflict.label}:${run.name}`,
        );
      }
    }
  }
});

test('booking success plus reschedule evidence deterministically requires human handling', () => {
  const step = conflictStep('booking-reschedule-conflict', 'Booking');
  const fixture = conflictFixtures.Booking;
  const success = fixture.keyedRow(step, fixture.success);
  const reschedule = fixture.keyedRow(step, fixture.reschedule);
  for (const run of [webhookEvidenceDecision, reconcileEvidenceDecision]) {
    const forward = run(step, [success, reschedule]);
    const reverse = run(step, [reschedule, success]);
    assert.deepEqual(forward, reverse, run.name);
    assert.equal(forward.state, 'HUMAN_REQUIRED');
    assert.equal(forward.status, 'reschedule_required');
    assert.equal(forward.parentState, 'HUMAN_REQUIRED');
    assert.equal(forward.proof.retry_legal, false);
    assert.deepEqual(forward.proof.evidence_classifications, ['HUMAN_REQUIRED:1', 'TERMINAL_SUCCESS:1']);
  }
});

test('terminal plus ambiguous evidence remains unresolved with no legal retry for every child type', () => {
  for (const childDay of Object.keys(conflictFixtures)) {
    const fixture = conflictFixtures[childDay];
    const step = conflictStep(`ambiguous-${childDay.toLowerCase()}`, childDay);
    const success = fixture.keyedRow(step, fixture.success);
    const ambiguous = fixture.keyedRow(step, fixture.ambiguous);
    for (const run of [webhookEvidenceDecision, reconcileEvidenceDecision]) {
      const forward = run(step, [success, ambiguous]);
      const reverse = run(step, [ambiguous, success]);
      assert.deepEqual(forward, reverse, `${childDay}:${run.name}`);
      assert.equal(forward.state, 'UNKNOWN_CHILD_RESULT', `${childDay}:${run.name}`);
      assert.equal(forward.status, 'conflicting_terminal_and_nonterminal_evidence', `${childDay}:${run.name}`);
      assert.equal(forward.parentState, 'UNKNOWN_CHILD_RESULT', `${childDay}:${run.name}`);
      assert.equal(forward.proof.retry_legal, false, `${childDay}:${run.name}`);
      assert.deepEqual(
        forward.proof.evidence_classifications,
        ['TERMINAL_SUCCESS:1', 'UNKNOWN_CHILD_RESULT:1'],
        `${childDay}:${run.name}`,
      );
    }
  }
});

test('duplicate success stays successful, while retry is legal only when every matched row proves failed-before-send', () => {
  const step = conflictStep('duplicate-and-retry', 'Invoice');
  const fixture = conflictFixtures.Invoice;
  const successRows = [fixture.keyedRow(step, fixture.success), fixture.keyedRow(step, fixture.success)];
  const retryRows = [
    fixture.keyedRow(step, { failed_before_send_proven: true, failed_before_send_marker: 'provider_rejected_b' }),
    fixture.keyedRow(step, { failed_before_send_proven: true, failed_before_send_marker: 'provider_rejected_a' }),
  ];
  const mixedRows = [retryRows[0], fixture.keyedRow(step, fixture.ambiguous)];
  for (const run of [webhookEvidenceDecision, reconcileEvidenceDecision]) {
    const success = run(step, successRows);
    assert.equal(success.state, 'TERMINAL_SUCCESS', run.name);
    assert.equal(success.parentState, 'COMPLETE', run.name);
    assert.equal(success.proof.retry_legal, false, run.name);
    assert.deepEqual(success.proof.evidence_classifications, ['TERMINAL_SUCCESS:2'], run.name);

    const retry = run(step, retryRows);
    const retryReversed = run(step, [...retryRows].reverse());
    assert.deepEqual(retry, retryReversed, run.name);
    assert.equal(retry.state, 'RETRYABLE_FAILURE', run.name);
    assert.equal(retry.parentState, 'PARTIAL_BLOCKED', run.name);
    assert.equal(retry.proof.retry_legal, true, run.name);
    assert.deepEqual(retry.proof.evidence_classifications, ['RETRYABLE_FAILURE:2'], run.name);

    const mixed = run(step, mixedRows);
    assert.equal(mixed.state, 'UNKNOWN_CHILD_RESULT', run.name);
    assert.equal(mixed.parentState, 'UNKNOWN_CHILD_RESULT', run.name);
    assert.equal(mixed.proof.retry_legal, false, run.name);
    assert.deepEqual(mixed.proof.evidence_classifications, ['RETRYABLE_FAILURE:1', 'UNKNOWN_CHILD_RESULT:1'], run.name);
  }
});

test('webhook step discovery and parent decisions preserve conflicting step identities independent of row order', () => {
  const normalized = normalizeOnboarding('duplicate-webhook-identities');
  const planned = plannedStep(normalized, 'first_invoice');
  const rowA = {
    ...duplicateInvoiceStep(normalized.onboarding_id, 'a-step-key', 'invoice-key-a'),
    smoke_tag: normalized.smoke_tag,
  };
  const rowZ = {
    ...duplicateInvoiceStep(normalized.onboarding_id, 'z-step-key', 'invoice-key-z', 'TERMINAL_SUCCESS'),
    smoke_tag: normalized.smoke_tag,
  };
  const discoveryResults = [[rowA, rowZ], [rowZ, rowA]].map((rows) => executeCodeNode(
    onboardingWorkflow,
    'Build Missing Step Intent Summary',
    {
      inputRows: rows,
      nodeOutputs: {
        'Normalize Onboarding': {
          ...normalized,
          planned_steps_json: JSON.stringify([planned]),
          required_steps_json: JSON.stringify(['first_invoice']),
        },
        'Build Claim Decision': { replay_terminal_state: 'COMPLETE' },
      },
    },
  ).json);
  assert.deepEqual(discoveryResults[0], discoveryResults[1]);
  assert.equal(discoveryResults[0].step_intent_count, 0);
  assert.equal(discoveryResults[0].replay_noop, false);
  assert.deepEqual(
    JSON.parse(discoveryResults[0].existing_step_rows_json).map((row) => row.step_key),
    ['a-step-key', 'z-step-key'],
  );

  const decisions = [[rowA, rowZ], [rowZ, rowA]].map((rows) => webhookDuplicateDecision(normalized, rows));
  assert.deepEqual(decisions[0], decisions[1]);
  assert.equal(decisions[0].state, 'HUMAN_REQUIRED');
  assert.equal(decisions[0].blockedReason, 'duplicate_step_identity_conflict:first_invoice');
  assert.deepEqual(decisions[0].summary.map((row) => row.step_key), ['a-step-key', 'z-step-key']);
  assert.equal(JSON.stringify(decisions[0].summary).includes('request_snapshot_bytes'), false);
});

for (const adoptedSorts of ['before', 'after']) {
  test(`reconcile duplicate step conflict is explicit when adopted identity sorts ${adoptedSorts} unproven identity`, () => {
    const onboardingId = `duplicate-reconcile-${adoptedSorts}`;
    const parent = parentRow(onboardingId, 'UNKNOWN_CHILD_RESULT', ['first_invoice']);
    const adoptedKey = adoptedSorts === 'before' ? 'a-adopted-step' : 'z-adopted-step';
    const unprovenKey = adoptedSorts === 'before' ? 'z-unproven-step' : 'a-unproven-step';
    const adopted = duplicateInvoiceStep(onboardingId, adoptedKey, `${onboardingId}:adopted`);
    const unproven = duplicateInvoiceStep(onboardingId, unprovenKey, `${onboardingId}:unproven`);
    const invoices = [scopedChildRow(adopted, { invoice_key: adopted.predicted_child_key, status: 'Invoice Sent' })];
    const runs = [[adopted, unproven], [unproven, adopted]].map((steps) => {
      const result = reconcile({ parents: [parent], steps, invoices });
      const adoptions = adoptedRows(result);
      const repairs = parentRepairRows(result);
      const parents = rollup({ parents: [parent], storedSteps: steps, adoptions: repairs });
      return { result, adoptions, repairs, parents, steps };
    });
    const normalizedRuns = runs.map(({ result, adoptions, repairs, parents }) => ({
      adoptionCount: result.adoption_count,
      adoptedKeys: adoptions.map((row) => row.step_key),
      parentRepairCount: result.parent_repair_count,
      repairKeys: repairs.map((row) => row.step_key),
      parentState: parents[0]?.state,
      blockedReason: parents[0]?.blocked_reason,
      summary: parents[0] ? JSON.parse(parents[0].step_summary_json) : [],
    }));
    assert.deepEqual(normalizedRuns[0], normalizedRuns[1]);
    for (const [index, run] of normalizedRuns.entries()) {
      assert.equal(run.adoptionCount, 0);
      assert.equal(runs[index].result.adopted_step_rows_json, '[]');
      assert.deepEqual(run.adoptedKeys, []);
      assert.equal(run.parentRepairCount, 1);
      assert.deepEqual(run.repairKeys, [adoptedSorts === 'before' ? adoptedKey : unprovenKey]);
      assert.equal(run.parentState, 'HUMAN_REQUIRED');
      assert.equal(run.blockedReason, 'duplicate_step_identity_conflict:first_invoice');
      assert.deepEqual(run.summary.map((row) => row.step_key).sort(), [adoptedKey, unprovenKey].sort());
      assert.equal(run.summary.find((row) => row.step_key === adoptedKey).state, 'UNKNOWN_CHILD_RESULT');
      assert.equal(run.summary.find((row) => row.step_key === unprovenKey).state, 'UNKNOWN_CHILD_RESULT');
      assert.equal(JSON.stringify(run.summary).includes('request_snapshot_bytes'), false);
    }

    const correctedParent = runs[0].parents[0];
    const repeat = reconcile({ parents: [correctedParent], steps: runs[0].steps, invoices });
    assert.equal(repeat.adoption_count, 0);
    assert.equal(repeat.parent_repair_count, 0);
    assert.deepEqual(adoptedRows(repeat), []);
    assert.deepEqual(parentRepairRows(repeat), []);
    assert.deepEqual(rollup({ parents: [correctedParent], storedSteps: runs[0].steps, adoptions: [] }), []);
  });
}

test('identical physical step rows collapse by step_key without a duplicate identity conflict', () => {
  const onboardingId = 'duplicate-physical-row';
  const parent = parentRow(onboardingId, 'UNKNOWN_CHILD_RESULT', ['first_invoice']);
  const step = duplicateInvoiceStep(onboardingId, 'same-step-key', `${onboardingId}:invoice`);
  const physicalRows = [structuredClone(step), structuredClone(step)];
  const result = reconcile({
    parents: [parent],
    steps: physicalRows,
    invoices: [scopedChildRow(step, { invoice_key: step.predicted_child_key, status: 'Invoice Sent' })],
  });
  const adoptions = adoptedRows(result);
  assert.equal(result.adoption_count, 1);
  assert.equal(adoptions.length, 1);
  const parents = rollup({ parents: [parent], storedSteps: physicalRows, adoptions });
  assert.equal(parents[0].state, 'COMPLETE');
  assert.equal(JSON.parse(parents[0].step_summary_json).length, 1);
  assert.doesNotMatch(parents[0].blocked_reason, /duplicate_step_identity_conflict/);

  const normalized = normalizeOnboarding('duplicate-physical-webhook');
  const webhookStep = {
    ...duplicateInvoiceStep(normalized.onboarding_id, 'same-webhook-step-key', 'same-webhook-invoice-key', 'TERMINAL_SUCCESS'),
    smoke_tag: normalized.smoke_tag,
  };
  const webhook = webhookDuplicateDecision(normalized, [webhookStep, structuredClone(webhookStep)]);
  assert.equal(webhook.state, 'COMPLETE');
  assert.equal(webhook.summary.length, 1);
  assert.doesNotMatch(webhook.blockedReason, /duplicate_step_identity_conflict/);
});

for (const childDay of Object.keys(conflictFixtures)) {
  test(`stored TERMINAL_SUCCESS ${childDay} evidence is reaggregated in webhook replay and reconcile`, () => {
    const fixture = conflictFixtures[childDay];
    const step = storedSuccessStep(`stored-terminal-${childDay.toLowerCase()}`, childDay);
    const success = fixture.keyedRow(step, fixture.success);
    const cases = [
      { label: 'review', conflicting: fixture.keyedRow(step, fixture.review), state: 'TERMINAL_REVIEW', parentState: 'HUMAN_REQUIRED' },
      { label: 'dead-letter', conflicting: fixture.keyedRow(step, fixture.deadLetter), state: 'TERMINAL_DEAD_LETTER', parentState: 'PARTIAL_BLOCKED' },
      { label: 'ambiguous', conflicting: fixture.keyedRow(step, fixture.ambiguous), state: 'UNKNOWN_CHILD_RESULT', parentState: 'UNKNOWN_CHILD_RESULT' },
      {
        label: 'retryable',
        conflicting: fixture.keyedRow(step, { failed_before_send_proven: true, failed_before_send_marker: 'provider_rejected_before_send' }),
        state: 'UNKNOWN_CHILD_RESULT',
        parentState: 'UNKNOWN_CHILD_RESULT',
      },
    ];
    const observations = [];
    for (const conflict of cases) {
      const rowOrders = [[success, conflict.conflicting], [conflict.conflicting, success]];
      const webhook = rowOrders.map((rows) => webhookStoredTerminalReplay(step, rows));
      const reconciled = rowOrders.map((rows) => reconcileStoredTerminalReplay(step, rows));
      observations.push({ conflict, webhook, reconciled });
    }

    for (const { conflict, webhook, reconciled } of observations) {
      assert.deepEqual(webhook[0], webhook[1], `${childDay}:${conflict.label}:webhook permutation`);
      assert.deepEqual(reconciled[0], reconciled[1], `${childDay}:${conflict.label}:reconcile permutation`);
      for (const result of webhook) {
        assert.equal(result.decisionState, conflict.state, `${childDay}:${conflict.label}:webhook state`);
        assert.equal(result.emitted.length, 1, `${childDay}:${conflict.label}:webhook step write`);
        assert.equal(result.emitted[0].state, conflict.state, `${childDay}:${conflict.label}:webhook persisted state`);
        assert.equal(result.parentState, conflict.parentState, `${childDay}:${conflict.label}:webhook parent`);
        assert.equal(result.shouldWriteParent, true, `${childDay}:${conflict.label}:webhook parent write`);
        assert.equal(result.replayNoop, false, `${childDay}:${conflict.label}:corrective replay`);
        assert.equal(result.emitted[0].proof.retry_legal, false, `${childDay}:${conflict.label}:webhook retry`);
      }
      for (const result of reconciled) {
        assert.equal(result.adoptionCount, 1, `${childDay}:${conflict.label}:reconcile adoption`);
        assert.equal(result.emitted[0].state, conflict.state, `${childDay}:${conflict.label}:reconcile persisted state`);
        assert.equal(result.parentState, conflict.parentState, `${childDay}:${conflict.label}:reconcile parent`);
        assert.equal(result.emitted[0].proof.retry_legal, false, `${childDay}:${conflict.label}:reconcile retry`);
      }
    }
  });
}

test('stored terminal duplicate success and missing current evidence remain idempotent', () => {
  for (const childDay of Object.keys(conflictFixtures)) {
    const fixture = conflictFixtures[childDay];
    const step = storedSuccessStep(`stored-idempotent-${childDay.toLowerCase()}`, childDay);
    const successRows = [fixture.keyedRow(step, fixture.success), fixture.keyedRow(step, fixture.success)];
    for (const rows of [successRows, []]) {
      const webhook = webhookStoredTerminalReplay(step, rows);
      assert.equal(webhook.decisionState, 'TERMINAL_SUCCESS', childDay);
      assert.equal(webhook.decisionStatus, 'already_terminal', childDay);
      assert.equal(webhook.emitted.length, 0, childDay);
      assert.equal(webhook.shouldWriteParent, false, childDay);
      assert.equal(webhook.parentState, 'COMPLETE', childDay);
      assert.equal(webhook.replayNoop, true, childDay);

      const reconciled = reconcileStoredTerminalReplay(step, rows);
      assert.equal(reconciled.adoptionCount, 0, childDay);
      assert.equal(reconciled.parentRepairCount, 0, childDay);
      assert.deepEqual(reconciled.emitted, [], childDay);
      assert.equal(reconciled.parentState, 'COMPLETE', childDay);
    }
  }
});

test('a corrected terminal conflict is a no-op on the next identical webhook replay and reconcile sweep', () => {
  const childDay = 'Invoice';
  const fixture = conflictFixtures[childDay];
  const step = storedSuccessStep('stored-terminal-repeat', childDay);
  const rows = [fixture.keyedRow(step, fixture.success), fixture.keyedRow(step, fixture.review)];

  const webhookFirst = webhookStoredTerminalReplay(step, rows);
  assert.equal(webhookFirst.emitted.length, 1);
  const webhookCorrectedStep = {
    ...step,
    state: webhookFirst.emitted[0].state,
    child_status: webhookFirst.emitted[0].status,
    child_proof_json: JSON.stringify(webhookFirst.emitted[0].proof),
  };
  const webhookSecond = webhookStoredTerminalReplay(webhookCorrectedStep, rows);
  assert.equal(webhookSecond.decisionState, 'TERMINAL_REVIEW');
  assert.equal(webhookSecond.decisionStatus, 'already_terminal');
  assert.equal(webhookSecond.emitted.length, 0);
  assert.equal(webhookSecond.shouldWriteParent, false);
  assert.equal(webhookSecond.replayNoop, true);
  assert.equal(webhookSecond.parentState, 'HUMAN_REQUIRED');

  const parent = parentRow(step.onboarding_id, 'COMPLETE', [step.step_name]);
  const first = reconcile({ parents: [parent], steps: [step], invoices: rows });
  const firstAdoptions = adoptedRows(first);
  assert.equal(firstAdoptions.length, 1);
  const correctedParent = rollup({ parents: [parent], storedSteps: [step], adoptions: firstAdoptions })[0];
  assert.equal(correctedParent.state, 'HUMAN_REQUIRED');
  const second = reconcile({ parents: [correctedParent], steps: firstAdoptions, invoices: rows });
  assert.equal(second.adoption_count, 0);
  assert.deepEqual(adoptedRows(second), []);
  assert.deepEqual(rollup({ parents: [correctedParent], storedSteps: firstAdoptions, adoptions: [] }), []);
});

test('booking reschedule HUMAN_REQUIRED remains sticky when reconcile sees only the confirmed old slot', () => {
  const childDay = 'Booking';
  const fixture = conflictFixtures[childDay];
  const step = storedSuccessStep('sticky-booking-reschedule', childDay);
  const completeParent = parentRow(step.onboarding_id, 'COMPLETE', [step.step_name]);
  const oldSlotEvidence = fixture.keyedRow(step, fixture.success);
  const requestedNewSlot = '2026-09-02T09:00:00Z';
  const runWebhook = (storedStep, parent) => executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': {
        ...parent,
        errors: [],
        planned_steps_json: JSON.stringify([storedStep]),
        child_fixtures_json: '{}',
        test_overrides_enabled: false,
        current_kickoff_slot_valid: true,
        current_kickoff_slot_start_utc: requestedNewSlot,
      },
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: JSON.stringify([storedStep]),
        intent_rows_json: '[]',
        replay_noop: true,
      },
    },
    nodeItems: {
      'Find Existing Onboarding Rows': [parent],
      'Find Booking Rows': [oldSlotEvidence],
    },
  }).json;

  const webhookFirst = runWebhook(step, completeParent);
  const correctedRows = JSON.parse(webhookFirst.terminal_rows_json);
  assert.equal(correctedRows.length, 1);
  assert.equal(correctedRows[0].state, 'HUMAN_REQUIRED');
  assert.equal(correctedRows[0].child_status, 'reschedule_required');
  assert.equal(JSON.parse(webhookFirst.final_onboarding_row_json).state, 'HUMAN_REQUIRED');
  assert.equal(webhookFirst.should_insert_final_onboarding, true);
  assert.equal(JSON.parse(webhookFirst.response_body_json).replay_noop, false);

  const humanParent = JSON.parse(webhookFirst.final_onboarding_row_json);
  const webhookRepeat = runWebhook(correctedRows[0], humanParent);
  assert.equal(JSON.parse(webhookRepeat.response_body_json).decisions[0].state, 'HUMAN_REQUIRED');
  assert.equal(JSON.parse(webhookRepeat.response_body_json).decisions[0].status, 'reschedule_required');
  assert.equal(JSON.parse(webhookRepeat.terminal_rows_json).length, 0);
  assert.equal(JSON.parse(webhookRepeat.final_onboarding_row_json).state, 'HUMAN_REQUIRED');
  assert.equal(webhookRepeat.should_insert_final_onboarding, false);
  assert.equal(JSON.parse(webhookRepeat.response_body_json).replay_noop, true);

  const reconcileFirst = reconcile({
    parents: [humanParent],
    steps: correctedRows,
    bookings: [oldSlotEvidence],
  });
  assert.equal(reconcileFirst.adoption_count, 0);
  assert.equal(reconcileFirst.parent_repair_count, 0);
  assert.deepEqual(adoptedRows(reconcileFirst), []);
  assert.deepEqual(rollup({ parents: [humanParent], storedSteps: correctedRows, adoptions: [] }), []);
  assert.equal(humanParent.state, 'HUMAN_REQUIRED');

  const reconcileRepeat = reconcile({
    parents: [humanParent],
    steps: correctedRows,
    bookings: [oldSlotEvidence],
  });
  assert.equal(reconcileRepeat.adoption_count, 0);
  assert.equal(reconcileRepeat.parent_repair_count, 0);
  assert.deepEqual(adoptedRows(reconcileRepeat), []);
  assert.equal(humanParent.state, 'HUMAN_REQUIRED');
});

test('webhook repairs a stale COMPLETE parent after the HUMAN_REQUIRED step write survived', () => {
  const normalized = normalizeOnboarding('partial-parent-webhook-booking');
  const storedSuccess = {
    ...plannedStep(normalized, 'kickoff_booking'),
    state: 'TERMINAL_SUCCESS',
    child_status: 'Confirmed',
    child_proof_json: JSON.stringify({ source: 'Bookings' }),
    blocked_reason: '',
  };
  const source = {
    ...normalized,
    required_steps_json: JSON.stringify(['kickoff_booking']),
    planned_steps_json: JSON.stringify([storedSuccess]),
    current_kickoff_slot_valid: true,
    current_kickoff_slot_start_utc: '2026-09-02T09:00:00Z',
  };
  const staleCompleteParent = {
    ...parentRow(normalized.onboarding_id, 'COMPLETE', ['kickoff_booking']),
    onboarding_identity: normalized.onboarding_identity,
    identity_source: normalized.identity_source,
    smoke_tag: normalized.smoke_tag,
    step_summary_json: JSON.stringify([{
      onboarding_id: normalized.onboarding_id,
      step_key: storedSuccess.step_key,
      step_name: storedSuccess.step_name,
      state: 'TERMINAL_SUCCESS',
      status: storedSuccess.child_status,
      predicted_child_key: storedSuccess.predicted_child_key,
    }]),
  };

  const first = webhookFromStoredRows({ source, parent: staleCompleteParent, steps: [storedSuccess] });
  const correctedSteps = JSON.parse(first.terminal_rows_json);
  assert.equal(correctedSteps.length, 1);
  assert.equal(correctedSteps[0].state, 'HUMAN_REQUIRED');
  assert.equal(JSON.parse(first.final_onboarding_row_json).state, 'HUMAN_REQUIRED');

  // Simulate Update Step Terminal Rows succeeding and Update Final Onboarding Row failing.
  const foreignTagParent = {
    ...JSON.parse(first.final_onboarding_row_json),
    smoke_tag: 'FOREIGN-PARTIAL-WRITE-TAG',
  };
  const repair = webhookFromStoredRows({
    source,
    parent: staleCompleteParent,
    steps: correctedSteps,
    storedParents: [foreignTagParent, staleCompleteParent],
  });
  assert.equal(JSON.parse(repair.terminal_rows_json).length, 0);
  assert.equal(JSON.parse(repair.final_onboarding_row_json).state, 'HUMAN_REQUIRED');
  assert.equal(repair.should_insert_final_onboarding, true);
  assert.equal(JSON.parse(repair.response_body_json).replay_noop, false);

  const durableParent = JSON.parse(repair.final_onboarding_row_json);
  const repeat = webhookFromStoredRows({
    source,
    parent: durableParent,
    steps: correctedSteps,
    storedParents: [foreignTagParent, durableParent],
  });
  assert.equal(JSON.parse(repeat.terminal_rows_json).length, 0);
  assert.equal(repeat.should_insert_final_onboarding, false);
  assert.equal(JSON.parse(repeat.response_body_json).replay_noop, true);
});

test('reconcile repairs stale parents without new child evidence and becomes idle after durability', () => {
  const humanId = 'partial-parent-reconcile-human';
  const humanStep = {
    ...conflictStep(humanId, 'Booking'),
    state: 'HUMAN_REQUIRED',
    child_status: 'reschedule_required',
    child_proof_json: JSON.stringify({ action: 'route_booking_change_contract' }),
    blocked_reason: 'reschedule_required',
  };
  const staleHumanParent = parentRow(humanId, 'COMPLETE', [humanStep.step_name]);

  const successId = 'partial-parent-reconcile-success';
  const successStep = {
    ...conflictStep(successId, 'Invoice'),
    state: 'TERMINAL_SUCCESS',
    child_status: 'Invoice Sent',
    child_proof_json: JSON.stringify({ source: 'Dunning_Invoices' }),
    blocked_reason: '',
  };
  const staleSuccessParent = parentRow(successId, 'UNKNOWN_CHILD_RESULT', [successStep.step_name]);

  const duplicateId = 'partial-parent-reconcile-duplicate';
  const duplicateA = duplicateInvoiceStep(duplicateId, 'a-terminal-step', 'invoice-a', 'TERMINAL_SUCCESS');
  const duplicateZ = duplicateInvoiceStep(duplicateId, 'z-terminal-step', 'invoice-z', 'TERMINAL_SUCCESS');
  const staleDuplicateParent = parentRow(duplicateId, 'COMPLETE', ['first_invoice']);
  const foreignTagStep = {
    ...duplicateInvoiceStep(humanId, 'foreign-tag-step', 'foreign-tag-invoice', 'TERMINAL_SUCCESS'),
    smoke_tag: 'FOREIGN-PARTIAL-WRITE-TAG',
  };
  const matchingForeignParent = {
    ...parentRow(humanId, 'COMPLETE', ['first_invoice']),
    smoke_tag: foreignTagStep.smoke_tag,
    step_summary_json: JSON.stringify([{
      onboarding_id: humanId,
      step_key: foreignTagStep.step_key,
      step_name: foreignTagStep.step_name,
      state: foreignTagStep.state,
      status: foreignTagStep.child_status,
      predicted_child_key: foreignTagStep.predicted_child_key,
    }]),
  };
  const parents = [staleHumanParent, staleSuccessParent, staleDuplicateParent, matchingForeignParent];
  const steps = [humanStep, successStep, duplicateZ, duplicateA, foreignTagStep];

  const repairSweep = reconcile({ parents, steps });
  const repairTriggers = parentRepairRows(repairSweep);
  assert.equal(repairSweep.adoption_count, 0);
  assert.equal(repairSweep.parent_repair_count, 3);
  assert.equal(repairTriggers.length, 3);
  assert.equal(repairTriggers.every((row) => row.parent_repair_trigger === true), true);
  assert.deepEqual(repairTriggers.map((row) => row.onboarding_id).sort(), [humanId, successId, duplicateId].sort());
  const emittedRepairRows = executeCodeNode(onboardingWorkflow, 'Emit Reconcile Adopted Step Rows', {
    input: repairSweep,
  }).map((item) => item.json);
  assert.deepEqual(emittedRepairRows, repairTriggers);

  const repairedParents = rollup({ parents, storedSteps: steps, adoptions: emittedRepairRows });
  assert.equal(repairedParents.length, 3);
  const byId = new Map(repairedParents.map((row) => [row.onboarding_id, row]));
  assert.equal(byId.get(humanId).state, 'HUMAN_REQUIRED');
  assert.equal(byId.get(successId).state, 'COMPLETE');
  assert.equal(byId.get(duplicateId).state, 'HUMAN_REQUIRED');
  assert.equal(byId.get(duplicateId).blocked_reason, 'duplicate_step_identity_conflict:first_invoice');
  assert.deepEqual(JSON.parse(byId.get(duplicateId).step_summary_json).map((row) => row.step_key), ['a-terminal-step', 'z-terminal-step']);

  const repeatSweep = reconcile({ parents: repairedParents, steps });
  assert.equal(repeatSweep.adoption_count, 0);
  assert.equal(repeatSweep.parent_repair_count, 0);
  assert.deepEqual(adoptedRows(repeatSweep), []);
  assert.deepEqual(parentRepairRows(repeatSweep), []);
  assert.deepEqual(rollup({ parents: repairedParents, storedSteps: steps, adoptions: [] }), []);
});

test('stored-terminal conflict correction remains owner- and tag-isolated', () => {
  const sharedKey = 'stored-terminal-shared-document-key';
  const stepA = { ...storedSuccessStep('stored-terminal-owner-a', 'Document'), predicted_child_key: sharedKey, smoke_tag: 'TAG-A' };
  const stepB = { ...storedSuccessStep('stored-terminal-owner-b', 'Document'), predicted_child_key: sharedKey, smoke_tag: 'TAG-B' };
  const parentA = { ...parentRow(stepA.onboarding_id, 'COMPLETE', [stepA.step_name]), smoke_tag: stepA.smoke_tag };
  const parentB = { ...parentRow(stepB.onboarding_id, 'COMPLETE', [stepB.step_name]), smoke_tag: stepB.smoke_tag };
  const fixture = conflictFixtures.Document;
  const rows = [
    fixture.keyedRow(stepA, fixture.success),
    fixture.keyedRow(stepA, fixture.review),
    fixture.keyedRow(stepB, fixture.success),
  ];
  const result = reconcile({ parents: [parentB, parentA], steps: [stepB, stepA], documents: rows });
  const adoptions = adoptedRows(result);
  assert.equal(adoptions.length, 1);
  assert.equal(adoptions[0].onboarding_id, stepA.onboarding_id);
  assert.equal(adoptions[0].smoke_tag, 'TAG-A');
  assert.equal(adoptions[0].state, 'TERMINAL_REVIEW');

  const rolled = rollup({ parents: [parentB, parentA], storedSteps: [stepB, stepA], adoptions });
  assert.equal(rolled.length, 1);
  assert.equal(rolled[0].onboarding_id, parentA.onboarding_id);
  assert.equal(rolled[0].smoke_tag, 'TAG-A');
  assert.equal(rolled[0].state, 'HUMAN_REQUIRED');
});

test('conflicting owner-bound evidence remains isolated across parents and run tags', () => {
  const sharedKey = 'shared-owner-bound-document-key';
  const stepA = { ...conflictStep('conflict-owner-a', 'Document'), predicted_child_key: sharedKey, smoke_tag: 'TAG-A' };
  const stepB = { ...conflictStep('conflict-owner-b', 'Document'), predicted_child_key: sharedKey, smoke_tag: 'TAG-B' };
  const parentA = { ...parentRow(stepA.onboarding_id, 'UNKNOWN_CHILD_RESULT', [stepA.step_name]), smoke_tag: stepA.smoke_tag };
  const parentB = { ...parentRow(stepB.onboarding_id, 'UNKNOWN_CHILD_RESULT', [stepB.step_name]), smoke_tag: stepB.smoke_tag };
  const fixture = conflictFixtures.Document;
  const rows = [
    fixture.keyedRow(stepA, fixture.success),
    fixture.keyedRow(stepA, fixture.review),
    fixture.keyedRow(stepB, fixture.success),
  ];
  const result = reconcile({ parents: [parentB, parentA], steps: [stepB, stepA], documents: rows });
  const adoptions = adoptedRows(result);
  assert.equal(adoptions.length, 2);
  const byOwner = new Map(adoptions.map((row) => [row.onboarding_id, row]));
  assert.equal(byOwner.get(stepA.onboarding_id).state, 'TERMINAL_REVIEW');
  assert.equal(byOwner.get(stepA.onboarding_id).smoke_tag, 'TAG-A');
  assert.equal(byOwner.get(stepB.onboarding_id).state, 'TERMINAL_SUCCESS');
  assert.equal(byOwner.get(stepB.onboarding_id).smoke_tag, 'TAG-B');

  const rolled = rollup({ parents: [parentB, parentA], storedSteps: [stepB, stepA], adoptions });
  const parentByOwner = new Map(rolled.map((row) => [row.onboarding_id, row]));
  assert.equal(parentByOwner.get(stepA.onboarding_id).state, 'HUMAN_REQUIRED');
  assert.equal(parentByOwner.get(stepB.onboarding_id).state, 'COMPLETE');
});

test('same owner and deterministic child key adopt only exact run-tag evidence in webhook and reconcile', () => {
  for (const childDay of Object.keys(conflictFixtures)) {
    const fixture = conflictFixtures[childDay];
    const owner = `same-owner-${childDay.toLowerCase()}`;
    const prodStep = {
      ...conflictStep(owner, childDay),
      step_key: `${owner}:${fixture.stepName}:prod`,
      smoke_tag: 'PROD-SCOPE',
    };
    const testStep = {
      ...prodStep,
      step_key: `${owner}:${fixture.stepName}:test`,
      smoke_tag: 'TEST-FIX-SCOPE',
    };
    const prodParent = {
      ...parentRow(owner, 'UNKNOWN_CHILD_RESULT', [fixture.stepName]),
      smoke_tag: prodStep.smoke_tag,
      blocked_reason: `${fixture.stepName}:no_terminal_child_row`,
      step_summary_json: JSON.stringify([{
        onboarding_id: prodStep.onboarding_id,
        step_key: prodStep.step_key,
        step_name: prodStep.step_name,
        state: prodStep.state,
        status: prodStep.child_status,
        predicted_child_key: prodStep.predicted_child_key,
      }]),
    };
    const testParent = { ...parentRow(owner, 'UNKNOWN_CHILD_RESULT', [fixture.stepName]), smoke_tag: testStep.smoke_tag };
    const testEvidence = fixture.keyedRow(testStep, fixture.success);

    const reconciled = reconcile({
      parents: [prodParent, testParent],
      steps: [prodStep, testStep],
      [fixture.reconcileField]: [testEvidence],
    });
    const adoptions = adoptedRows(reconciled);
    assert.equal(reconciled.adoption_count, 1, `${childDay}: exact adoption count`);
    assert.equal(adoptions.length, 1, childDay);
    assert.equal(adoptions[0].step_key, testStep.step_key, childDay);
    assert.equal(adoptions[0].smoke_tag, testStep.smoke_tag, childDay);
    assert.equal(adoptions[0].state, 'TERMINAL_SUCCESS', childDay);
    assert.equal(JSON.parse(prodStep.child_proof_json).retry_legal, false, childDay);

    const webhook = (step) => executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
      nodeOutputs: {
        'Normalize Onboarding': {
          ...parentRow(owner, 'UNKNOWN_CHILD_RESULT', [fixture.stepName]),
          smoke_tag: step.smoke_tag,
          errors: [],
          planned_steps_json: JSON.stringify([step]),
          child_fixtures_json: '{}',
          test_overrides_enabled: false,
          current_kickoff_slot_valid: true,
          current_kickoff_slot_start_utc: '2026-09-01T09:00:00Z',
        },
        'Build Missing Step Intent Summary': {
          existing_step_rows_json: JSON.stringify([step]),
          intent_rows_json: '[]',
          replay_noop: false,
        },
      },
      nodeItems: { [fixture.webhookNode]: [testEvidence] },
    }).json;
    const prodWebhook = webhook(prodStep);
    const testWebhook = webhook(testStep);
    assert.equal(JSON.parse(prodWebhook.response_body_json).decisions[0].state, 'UNKNOWN_CHILD_RESULT', `${childDay}:prod webhook`);
    assert.equal(prodWebhook.terminal_row_count, 0, `${childDay}:prod webhook writes`);
    assert.equal(JSON.parse(testWebhook.response_body_json).decisions[0].state, 'TERMINAL_SUCCESS', `${childDay}:test webhook`);
    assert.equal(testWebhook.terminal_row_count, 1, `${childDay}:test webhook writes`);

    const updatedSteps = replaceAdopted([prodStep, testStep], adoptions);
    const rolledParents = rollup({ parents: [prodParent, testParent], storedSteps: [prodStep, testStep], adoptions });
    assert.equal(rolledParents.length, 1, `${childDay}:one parent scope`);
    assert.equal(rolledParents[0].smoke_tag, testStep.smoke_tag, childDay);
    const repeated = reconcile({
      parents: [prodParent, rolledParents[0]],
      steps: updatedSteps,
      [fixture.reconcileField]: [testEvidence],
    });
    assert.equal(repeated.adoption_count, 0, `${childDay}:repeat sweep`);
    assert.equal(repeated.parent_repair_count, 0, `${childDay}:repeat parent repair`);
  }
});

test('cross-tag conflicts are permutation-invariant and cannot rewrite a stored terminal scope', () => {
  for (const childDay of Object.keys(conflictFixtures)) {
    const fixture = conflictFixtures[childDay];
    const owner = `permuted-tag-owner-${childDay.toLowerCase()}`;
    const prodStep = {
      ...storedSuccessStep(owner, childDay),
      step_key: `${owner}:${fixture.stepName}:prod`,
      smoke_tag: 'PROD-SCOPE',
    };
    const testStep = {
      ...conflictStep(owner, childDay),
      step_key: `${owner}:${fixture.stepName}:test`,
      predicted_child_key: prodStep.predicted_child_key,
      smoke_tag: 'TEST-FIX-SCOPE',
    };
    const prodSuccess = fixture.keyedRow(prodStep, fixture.success);
    const testReview = fixture.keyedRow(testStep, fixture.review);
    const permutations = [[prodSuccess, testReview], [testReview, prodSuccess]];

    const testDecisions = permutations.map((rows) => webhookEvidenceDecision(testStep, rows));
    assert.deepEqual(testDecisions[0], testDecisions[1], childDay);
    assert.equal(testDecisions[0].state, 'TERMINAL_REVIEW', childDay);
    assert.equal(testDecisions[0].proof.evidence_match_count, 1, childDay);

    for (const rows of permutations) {
      const webhookReplay = webhookStoredTerminalReplay(prodStep, rows);
      assert.deepEqual(webhookReplay.emitted, [], `${childDay}:stored webhook scope`);
      assert.equal(webhookReplay.shouldWriteParent, false, `${childDay}:stored webhook parent`);
      const reconcileReplay = reconcileStoredTerminalReplay(prodStep, rows);
      assert.equal(reconcileReplay.adoptionCount, 0, `${childDay}:stored reconcile scope`);
      assert.equal(reconcileReplay.parentRepairCount, 0, `${childDay}:stored reconcile parent`);
      assert.deepEqual(reconcileReplay.emitted, [], `${childDay}:stored reconcile writes`);
      assert.equal(reconcileReplay.parentState, 'COMPLETE', `${childDay}:stored reconcile state`);
    }

    const untagged = { ...testReview };
    delete untagged.smoke_tag;
    const unresolvedParent = { ...parentRow(owner, 'UNKNOWN_CHILD_RESULT', [fixture.stepName]), smoke_tag: testStep.smoke_tag };
    const unresolved = reconcile({
      parents: [unresolvedParent],
      steps: [testStep],
      [fixture.reconcileField]: [untagged],
    });
    assert.equal(unresolved.adoption_count, 0, `${childDay}:untagged evidence`);
    assert.equal(unresolved.unresolved_unknown_count, 1, `${childDay}:untagged unresolved`);
    assert.equal(JSON.parse(testStep.child_proof_json).retry_legal, false, `${childDay}:untagged retry`);
  }
});

test('multiple onboardings adopt and roll up without key or state cross-contamination', () => {
  const successParent = parentRow('isolated-success');
  const reviewParent = parentRow('isolated-review');
  const successStep = stepRow(successParent.onboarding_id, { predicted_child_key: 'key-success-only' });
  const reviewStep = stepRow(reviewParent.onboarding_id, { predicted_child_key: 'key-review-only' });
  const storedSteps = [
    successStep,
    terminalCompanion(successParent.onboarding_id),
    reviewStep,
    terminalCompanion(reviewParent.onboarding_id),
  ];
  const result = reconcile({
    parents: [reviewParent, successParent],
    steps: storedSteps,
    invoices: [
      scopedChildRow(reviewStep, { invoice_key: reviewStep.predicted_child_key, status: 'Needs Review' }),
      scopedChildRow(successStep, { invoice_key: successStep.predicted_child_key, status: 'Invoice Sent' }),
    ],
  });
  const adoptions = adoptedRows(result);
  assert.equal(adoptions.length, 2);
  const rolled = rollup({ parents: [reviewParent, successParent], storedSteps, adoptions });
  const byId = new Map(rolled.map((row) => [row.onboarding_id, row]));
  assert.equal(byId.get(successParent.onboarding_id).state, 'COMPLETE');
  assert.equal(byId.get(reviewParent.onboarding_id).state, 'HUMAN_REQUIRED');
  for (const [id, row] of byId) {
    const summary = JSON.parse(row.step_summary_json);
    assert.equal(summary.length, 2);
    assert.ok(summary.every((step) => step.onboarding_id === id));
    assert.ok(summary.every((step) => step.step_key.startsWith(`${id}:`)));
  }
});

test('a repeated reconcile sweep is idempotent after the first adoption', () => {
  const parent = parentRow('repeat-sweep');
  const unknown = stepRow(parent.onboarding_id);
  const companion = terminalCompanion(parent.onboarding_id);
  const invoices = [scopedChildRow(unknown, { invoice_key: unknown.predicted_child_key, invoice_email_sent: true })];
  const first = reconcile({ parents: [parent], steps: [unknown, companion], invoices });
  const firstAdoptions = adoptedRows(first);
  assert.equal(firstAdoptions.length, 1);
  const updatedSteps = replaceAdopted([unknown, companion], firstAdoptions);
  const completedParent = rollup({ parents: [parent], storedSteps: [unknown, companion], adoptions: firstAdoptions })[0];
  const second = reconcile({ parents: [completedParent], steps: updatedSteps, invoices });
  assert.equal(second.adoption_count, 0);
  assert.deepEqual(adoptedRows(second), []);
  assert.deepEqual(rollup({ parents: [completedParent], storedSteps: updatedSteps, adoptions: [] }), []);
});

for (const nodeName of ['Update Final Onboarding Row', 'Update Reconcile Parent Rows']) {
  test(`${nodeName} atomically excludes a cancellation persisted after its decision`, () => {
    const workflow = loadWorkflow(onboardingWorkflow);
    const updateNode = workflow.nodes.find((node) => node.name === nodeName);
    const conditions = updateNode.parameters.filters.conditions;
    const emittedComplete = {
      ...parentRow(`cancel-race-${nodeName}`, 'COMPLETE'),
      blocked_reason: '',
      updated_at_utc: '2026-01-06T00:00:00.000Z',
      last_execution_id: 'stale-complete-decision',
    };
    const cancelledAfterDecision = {
      ...emittedComplete,
      state: 'CANCELLED',
      blocked_reason: 'cancelled_concurrently',
      updated_at_utc: '2026-01-07T00:00:00.000Z',
      last_execution_id: 'operator-cancellation',
    };
    const activeCurrent = {
      ...emittedComplete,
      state: 'UNKNOWN_CHILD_RESULT',
      blocked_reason: 'awaiting_evidence',
      updated_at_utc: '2026-01-05T00:00:00.000Z',
      last_execution_id: 'active-current-row',
    };

    assert.equal(updateNode.parameters.matchType, 'allConditions');
    assert.equal(updateNode.onError, 'stopWorkflow');
    assert.notEqual(updateNode.alwaysOutputData, true);
    const outgoing = workflow.connections[nodeName] || {};
    const mainTargets = (outgoing.main || []).flat().map((edge) => edge.node);
    const bypassTargets = Object.entries(outgoing)
      .filter(([output]) => output !== 'main')
      .flatMap(([, channels]) => (channels || []).flat().map((edge) => edge.node));
    assert.deepEqual(bypassTargets, []);
    assert.deepEqual(
      mainTargets,
      nodeName === 'Update Final Onboarding Row' ? ['Build Webhook Response'] : [],
    );

    const raced = simulateParentUpdate([cancelledAfterDecision], emittedComplete, conditions);
    assert.deepEqual({
      matchingIndexes: raced.matchingIndexes,
      persistedState: raced.rows[0].state,
      persistedBlockedReason: raced.rows[0].blocked_reason,
    }, {
      matchingIndexes: [],
      persistedState: 'CANCELLED',
      persistedBlockedReason: 'cancelled_concurrently',
    });

    assert.deepEqual(
      conditions.map(({ keyName, condition, keyValue }) => ({ keyName, condition, keyValue })),
      [
        { keyName: 'onboarding_id', condition: 'eq', keyValue: '={{ $json.onboarding_id }}' },
        { keyName: 'smoke_tag', condition: 'eq', keyValue: '={{ $json.smoke_tag }}' },
        { keyName: 'state', condition: 'neq', keyValue: 'CANCELLED' },
      ],
    );
    assert.deepEqual(raced.rows, [cancelledAfterDecision]);

    const active = simulateParentUpdate([activeCurrent], emittedComplete, conditions);
    assert.deepEqual(active.matchingIndexes, [0]);
    assert.equal(active.rows[0].state, 'COMPLETE');

    const duplicateRows = simulateParentUpdate(
      [cancelledAfterDecision, activeCurrent],
      emittedComplete,
      [...conditions].reverse(),
    );
    assert.deepEqual(duplicateRows.matchingIndexes, [1]);
    assert.deepEqual(duplicateRows.rows[0], cancelledAfterDecision);
    assert.equal(duplicateRows.rows[1].state, 'COMPLETE');

    const replayOnce = simulateParentUpdate(raced.rows, emittedComplete, conditions);
    const replayTwice = simulateParentUpdate(replayOnce.rows, emittedComplete, conditions);
    assert.deepEqual(replayOnce.matchingIndexes, []);
    assert.deepEqual(replayTwice.matchingIndexes, []);
    assert.deepEqual(replayTwice.rows, [cancelledAfterDecision]);
  });
}

test('every literal nodeRows lookup names an actual workflow node', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const nodeNames = new Set(workflow.nodes.map((node) => node.name));
  const lookups = workflow.nodes.flatMap((node) => {
    if (node.type !== 'n8n-nodes-base.code') return [];
    return [...String(node.parameters.jsCode || '').matchAll(/nodeRows\((['"])(.*?)\1\)/g)]
      .map((match) => ({ caller: node.name, target: match[2] }));
  });
  assert.ok(lookups.length > 0);
  for (const lookup of lookups) {
    assert.ok(nodeNames.has(lookup.target), `${lookup.caller} references missing node ${lookup.target}`);
  }
});

test('reconcile adoption connection reaches parent rollup and update without a child resend node', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  for (const connection of Object.values(workflow.connections)) {
    for (const outputs of connection.main || []) {
      for (const edge of outputs || []) assert.ok(nodesByName.has(edge.node), `missing connected node ${edge.node}`);
    }
  }
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  assert.deepEqual(next('Update Reconcile Adopted Step Rows'), ['Build Reconcile Parent Rollups']);
  assert.deepEqual(next('Build Reconcile Parent Rollups'), ['Reconcile Parent Updates Needed?']);
  assert.deepEqual(next('Reconcile Parent Updates Needed?'), ['Emit Reconcile Parent Rows']);
  assert.deepEqual(next('Emit Reconcile Parent Rows'), ['Update Reconcile Parent Rows']);
  assert.deepEqual(next('Update Reconcile Parent Rows'), []);
  assert.equal(nodesByName.get('Update Reconcile Parent Rows').onError, 'stopWorkflow');
  assert.equal(
    nodesByName.get('Reconcile Step Adoptions Needed?').parameters.conditions.conditions[0].leftValue,
    '={{ $json.adoption_count + $json.parent_repair_count }}',
  );
  const adoptionUpdate = nodesByName.get('Update Reconcile Adopted Step Rows');
  assert.equal(adoptionUpdate.onError, 'stopWorkflow');
  assert.deepEqual(
    adoptionUpdate.parameters.filters.conditions.map((condition) => condition.keyName),
    ['step_key', 'onboarding_id', 'smoke_tag'],
  );

  const reachable = new Set();
  const queue = ['Update Reconcile Adopted Step Rows'];
  while (queue.length) {
    const name = queue.shift();
    if (reachable.has(name)) continue;
    reachable.add(name);
    queue.push(...next(name));
  }
  for (const name of reachable) {
    const type = nodesByName.get(name)?.type || '';
    assert.notEqual(name, 'Build Webhook Response');
    assert.notEqual(type, 'n8n-nodes-base.gmail', name);
    assert.notEqual(type, 'n8n-nodes-base.executeWorkflow', name);
    assert.notEqual(type, 'n8n-nodes-base.httpRequest', name);
    assert.notEqual(type, 'n8n-nodes-base.respondToWebhook', name);
  }
});

test('critical webhook persistence nodes fail-stop before their accepted-response descendants', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const critical = [
    'Insert Onboarding Claim Row',
    'Insert Step Intent Rows',
    'Update Step Terminal Rows',
    'Update Final Onboarding Row',
  ];
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  const reaches = (start, target) => {
    const seen = new Set();
    const queue = [...next(start)];
    while (queue.length) {
      const name = queue.shift();
      if (name === target) return true;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...next(name));
    }
    return false;
  };
  const actual = critical.map((name) => {
    const connections = workflow.connections[name] || {};
    const explicitBypassTargets = Object.entries(connections)
      .filter(([output]) => output !== 'main')
      .flatMap(([, channels]) => (channels || []).flat().map((edge) => edge.node));
    return {
      name,
      onError: nodesByName.get(name)?.onError,
      reachesAcceptedOnSuccess: reaches(name, 'Respond Accepted'),
      explicitBypassTargets,
    };
  });
  assert.deepEqual(actual, critical.map((name) => ({
    name,
    onError: 'stopWorkflow',
    reachesAcceptedOnSuccess: true,
    explicitBypassTargets: [],
  })));
});

test('parent discovery read failure stops before claim, missing-intent planning, writes, and accepted', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const readNode = nodesByName.get('Find Existing Onboarding Rows');
  const normalized = normalizeOnboarding('parent-read-failure-control');
  const planned = JSON.parse(normalized.planned_steps_json);
  const cancelled = {
    ...parentRow(normalized.onboarding_id, 'CANCELLED'),
    smoke_tag: normalized.smoke_tag,
    blocked_reason: 'persisted_cancellation_hidden_by_failed_read',
  };
  const completed = {
    ...parentRow(normalized.onboarding_id, 'COMPLETE', planned.map((row) => row.step_name)),
    smoke_tag: normalized.smoke_tag,
    blocked_reason: '',
  };
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  const reaches = (start, target) => {
    const seen = new Set();
    const queue = [...next(start)];
    while (queue.length) {
      const name = queue.shift();
      if (name === target) return true;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...next(name));
    }
    return false;
  };
  const simulateParentRead = ({ readFailed, storedParentRows, storedStepRows }) => {
    const stopped = readFailed && readNode.onError === 'stopWorkflow';
    if (stopped) {
      return {
        downstream_execution_count: 0,
        intent_count: 0,
        emitted_step_keys: [],
        write_attempt_count: 0,
        accepted_reachable: false,
      };
    }

    // n8n 2.33.3 passes Normalize's item on regular output when this read fails.
    // alwaysOutputData supplies one empty item for a healthy, legitimate zero-row read.
    const parentReadOutput = readFailed ? [normalized] : (storedParentRows.length ? storedParentRows : [{}]);
    const claim = executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
      inputRows: parentReadOutput,
      nodeOutputs: { 'Normalize Onboarding': normalized },
    }).json;
    const stepReadOutput = storedStepRows.length ? storedStepRows : [{}];
    const summary = executeCodeNode(onboardingWorkflow, 'Build Missing Step Intent Summary', {
      inputRows: stepReadOutput,
      nodeOutputs: {
        'Normalize Onboarding': normalized,
        'Build Claim Decision': claim,
      },
    }).json;
    const emitted = summary.step_intent_count > 0
      ? executeCodeNode(onboardingWorkflow, 'Emit Step Intent Rows', { input: summary })
      : [];
    return {
      downstream_execution_count: 2 + (emitted.length > 0 ? 2 : 0),
      intent_count: summary.step_intent_count,
      emitted_step_keys: emitted.map((item) => item.json.step_key),
      write_attempt_count: emitted.length > 0 ? 1 : 0,
      accepted_reachable: reaches('Find Existing Onboarding Rows', 'Respond Accepted'),
    };
  };

  assert.deepEqual(next('Normalize Onboarding'), ['Onboarding Valid?']);
  assert.ok(next('Onboarding Valid?').includes('Find Existing Onboarding Rows'));
  assert.deepEqual(next('Find Existing Onboarding Rows'), ['Build Claim Decision']);
  assert.ok(reaches('Build Claim Decision', 'Build Missing Step Intent Summary'));
  assert.deepEqual(next('Build Missing Step Intent Summary'), ['Step Intents Needed?']);
  assert.ok(next('Step Intents Needed?').includes('Emit Step Intent Rows'));
  assert.deepEqual(next('Emit Step Intent Rows'), ['Insert Step Intent Rows']);

  const failedRead = simulateParentRead({
    readFailed: true,
    storedParentRows: [cancelled],
    storedStepRows: [],
  });
  assert.deepEqual(failedRead, {
    downstream_execution_count: 0,
    intent_count: 0,
    emitted_step_keys: [],
    write_attempt_count: 0,
    accepted_reachable: false,
  });

  assert.equal(readNode.onError, 'stopWorkflow');
  assert.equal(readNode.alwaysOutputData, true);
  const errorBypassTargets = Object.entries(workflow.connections['Find Existing Onboarding Rows'] || {})
    .filter(([output]) => output !== 'main')
    .flatMap(([, channels]) => (channels || []).flat().map((edge) => edge.node));
  assert.deepEqual(errorBypassTargets, []);

  const firstDelivery = simulateParentRead({
    readFailed: false,
    storedParentRows: [],
    storedStepRows: [],
  });
  assert.equal(firstDelivery.intent_count, 6);
  assert.deepEqual(firstDelivery.emitted_step_keys, planned.map((row) => row.step_key));
  assert.equal(firstDelivery.write_attempt_count, 1);
  assert.equal(firstDelivery.accepted_reachable, true);

  const cancelledReplay = simulateParentRead({
    readFailed: false,
    storedParentRows: [cancelled],
    storedStepRows: [],
  });
  assert.equal(cancelledReplay.intent_count, 0);
  assert.deepEqual(cancelledReplay.emitted_step_keys, []);
  assert.equal(cancelledReplay.write_attempt_count, 0);

  const completedReplay = simulateParentRead({
    readFailed: false,
    storedParentRows: [completed],
    storedStepRows: planned,
  });
  assert.equal(completedReplay.intent_count, 0);
  assert.deepEqual(completedReplay.emitted_step_keys, []);
  assert.equal(completedReplay.write_attempt_count, 0);
});

test('step discovery read failure stops before missing-intent planning and the accepted response', () => {
  const workflow = loadWorkflow(onboardingWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const readNode = nodesByName.get('Find Existing Step Rows');
  const normalized = normalizeOnboarding('step-read-failure-control');
  const existingSteps = JSON.parse(normalized.planned_steps_json);
  const claimInput = { ...normalized, replay_terminal_state: '' };
  const next = (name) => (workflow.connections[name]?.main || []).flat().map((edge) => edge.node);
  const reaches = (start, target) => {
    const seen = new Set();
    const queue = [...next(start)];
    while (queue.length) {
      const name = queue.shift();
      if (name === target) return true;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...next(name));
    }
    return false;
  };
  const simulateStepRead = ({ readFailed, storedRows }) => {
    const stopped = readFailed && readNode.onError === 'stopWorkflow';
    if (stopped) {
      return {
        downstream_execution_count: 0,
        intent_count: 0,
        emitted_step_keys: [],
        write_attempt_count: 0,
        accepted_reachable: false,
      };
    }

    // n8n 2.33.3 passes the upstream item on the regular output when this read fails.
    // alwaysOutputData supplies one empty item for a healthy, legitimate zero-row read.
    const readOutput = readFailed ? [claimInput] : (storedRows.length ? storedRows : [{}]);
    const summary = executeCodeNode(onboardingWorkflow, 'Build Missing Step Intent Summary', {
      inputRows: readOutput,
      nodeOutputs: {
        'Normalize Onboarding': normalized,
        'Build Claim Decision': claimInput,
      },
    }).json;
    const emitted = summary.step_intent_count > 0
      ? executeCodeNode(onboardingWorkflow, 'Emit Step Intent Rows', { input: summary })
      : [];
    return {
      downstream_execution_count: 1 + (emitted.length > 0 ? 1 : 0),
      intent_count: summary.step_intent_count,
      emitted_step_keys: emitted.map((item) => item.json.step_key),
      write_attempt_count: emitted.length > 0 ? 1 : 0,
      accepted_reachable: reaches('Find Existing Step Rows', 'Respond Accepted'),
    };
  };

  const failedRead = simulateStepRead({ readFailed: true, storedRows: existingSteps });
  assert.deepEqual(failedRead, {
    downstream_execution_count: 0,
    intent_count: 0,
    emitted_step_keys: [],
    write_attempt_count: 0,
    accepted_reachable: false,
  });

  assert.equal(readNode.onError, 'stopWorkflow');
  assert.equal(readNode.alwaysOutputData, true);
  const errorBypassTargets = Object.entries(workflow.connections['Find Existing Step Rows'] || {})
    .filter(([output]) => output !== 'main')
    .flatMap(([, channels]) => (channels || []).flat().map((edge) => edge.node));
  assert.deepEqual(errorBypassTargets, []);

  const firstDelivery = simulateStepRead({ readFailed: false, storedRows: [] });
  assert.equal(firstDelivery.intent_count, 6);
  assert.deepEqual(firstDelivery.emitted_step_keys, existingSteps.map((row) => row.step_key));
  assert.equal(firstDelivery.write_attempt_count, 1);
  assert.equal(firstDelivery.accepted_reachable, true);

  const existingReplay = simulateStepRead({ readFailed: false, storedRows: existingSteps });
  assert.equal(existingReplay.intent_count, 0);
  assert.deepEqual(existingReplay.emitted_step_keys, []);
  assert.equal(existingReplay.write_attempt_count, 0);

  const storedReplay = simulateStepRead({
    readFailed: false,
    storedRows: firstDelivery.emitted_step_keys.map((stepKey) => (
      existingSteps.find((row) => row.step_key === stepKey)
    )),
  });
  assert.equal(storedReplay.intent_count, 0);
  assert.deepEqual(storedReplay.emitted_step_keys, []);
  assert.equal(storedReplay.write_attempt_count, 0);
});

test('actual downstream Code builders ignore persistence error items and reread planned decisions', () => {
  const normalized = normalizeOnboarding('persistence-error-control');
  const planned = JSON.parse(normalized.planned_steps_json);
  const writeErrorItem = {
    onboarding_id: normalized.onboarding_id,
    smoke_tag: normalized.smoke_tag,
    error: 'SYNTHETIC_PERSISTENCE_FAILURE [line 1]',
  };
  const summary = executeCodeNode(onboardingWorkflow, 'Build Missing Step Intent Summary', {
    inputRows: [writeErrorItem],
    nodeOutputs: {
      'Normalize Onboarding': normalized,
      'Build Claim Decision': { replay_terminal_state: '' },
    },
  }).json;
  assert.equal(summary.step_intent_count, planned.length);
  assert.equal(summary.row_count_before_steps, 1);
  assert.deepEqual(JSON.parse(summary.intent_rows_json).map((row) => row.step_key), planned.map((row) => row.step_key));

  const parentDecision = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    input: writeErrorItem,
    nodeOutputs: {
      'Normalize Onboarding': normalized,
      'Build Missing Step Intent Summary': summary,
    },
  }).json;
  assert.equal(parentDecision.should_insert_final_onboarding, true);
  assert.equal(parentDecision.terminal_row_count, planned.length);
  assert.equal(JSON.parse(parentDecision.response_body_json).onboarding_id, normalized.onboarding_id);

  const finalWriteSource = executeCodeNode(onboardingWorkflow, 'Build Final Write Source', {
    input: writeErrorItem,
    nodeOutputs: { 'Build Parent Saga Decisions': parentDecision },
  }).json;
  assert.deepEqual(finalWriteSource, parentDecision);

  const response = executeCodeNode(onboardingWorkflow, 'Build Webhook Response', {
    input: writeErrorItem,
    nodeOutputs: { 'Build Parent Saga Decisions': parentDecision },
  }).json;
  assert.deepEqual(response, JSON.parse(parentDecision.response_body_json));
  assert.equal(response.onboarding_id, normalized.onboarding_id);
});

test('webhook terminal updates isolate identical step keys by onboarding owner and run tag', () => {
  const body = {
    deal_id: 'same-business-identity',
    client_name: 'Ada Example',
    company: 'Example Client Sp. z o.o.',
    verified_email: 'same-scope@example.test',
    service_code: 'workflow_build',
    quantity: 2,
    request_details: 'Build the approved client workflow.',
    kickoff_slot_start: '2026-09-01T09:00:00Z',
    kickoff_slot_end: '2026-09-01T10:00:00Z',
    kickoff_slot_tz: 'UTC',
    filename: 'signed-agreement.pdf',
    mime_type: 'application/pdf',
    file_sha256: 'a'.repeat(64),
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const normal = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: { body },
  }).json;
  const fixture = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: {
      body: { ...body, test_mode: true, smoke_tag: 'TEST-FIX-AUDIT', child_fixtures: {} },
      headers: { 'x-onboarding-test-mode': 'fixtures' },
    },
    vars: { ONBOARDING_ALLOW_TEST_OVERRIDES: 'true' },
  }).json;
  assert.equal(normal.ok, true);
  assert.equal(fixture.ok, true);
  assert.equal(fixture.test_overrides_enabled, true);

  const normalStep = plannedStep(normal, 'welcome_email');
  const fixtureStep = plannedStep(fixture, 'welcome_email');
  assert.equal(normal.onboarding_id, fixture.onboarding_id);
  assert.equal(normalStep.step_key, fixtureStep.step_key);
  assert.equal(normalStep.onboarding_id, fixtureStep.onboarding_id);
  assert.equal(normalStep.smoke_tag, 'ONBOARDING-DRAFT');
  assert.equal(fixtureStep.smoke_tag, 'TEST-FIX-AUDIT');

  const buildTerminal = (normalized, step) => executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': { ...normalized, planned_steps_json: JSON.stringify([step]) },
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: '[]',
        intent_rows_json: JSON.stringify([step]),
        replay_noop: false,
      },
    },
  }).json;
  const normalDecision = buildTerminal(normal, normalStep);
  const fixtureDecision = buildTerminal(fixture, fixtureStep);
  const normalTerminal = JSON.parse(normalDecision.terminal_rows_json)[0];
  const fixtureTerminal = JSON.parse(fixtureDecision.terminal_rows_json)[0];
  assert.equal(normalTerminal.step_key, fixtureTerminal.step_key);
  assert.equal(normalTerminal.smoke_tag, 'ONBOARDING-DRAFT');
  assert.equal(fixtureTerminal.smoke_tag, 'TEST-FIX-AUDIT');

  const workflow = loadWorkflow(onboardingWorkflow);
  const updater = workflow.nodes.find((node) => node.name === 'Update Step Terminal Rows');
  const conditions = updater.parameters.filters.conditions;
  const storedRows = [structuredClone(normalStep), structuredClone(fixtureStep)];
  const before = structuredClone(storedRows);
  const matchingIndexes = storedRows
    .map((row, index) => terminalUpdateMatches(row, fixtureTerminal, conditions) ? index : -1)
    .filter((index) => index >= 0);
  assert.deepEqual(matchingIndexes, [1]);

  const updated = storedRows.map((row) => (
    terminalUpdateMatches(row, fixtureTerminal, conditions) ? { ...row, ...fixtureTerminal } : row
  ));
  assert.equal(JSON.stringify(updated[0]), JSON.stringify(before[0]));
  assert.notEqual(JSON.stringify(updated[1]), JSON.stringify(before[1]));
  assert.equal(updated[1].state, 'TERMINAL_SUCCESS');
  assert.equal(updated[1].smoke_tag, 'TEST-FIX-AUDIT');
  assert.equal(updater.parameters.matchType, 'allConditions');
  assert.deepEqual(
    conditions.map(({ keyName, condition, keyValue }) => ({ keyName, condition, keyValue })),
    [
      { keyName: 'step_key', condition: 'eq', keyValue: '={{ $json.match_step_key || $json.step_key }}' },
      { keyName: 'onboarding_id', condition: 'eq', keyValue: '={{ $json.onboarding_id }}' },
      { keyName: 'smoke_tag', condition: 'eq', keyValue: '={{ $json.smoke_tag }}' },
    ],
  );
});
