'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { executeCodeNode, loadWorkflow, workflowFile } = require('./helpers/workflow-vm');

const onboardingWorkflow = workflowFile('08-client-onboarding-saga');
const invoiceWorkflow = workflowFile('02-invoice-dunning');
const documentWorkflow = workflowFile('03-document-intake');
const supportWorkflow = workflowFile('04-support-triage');
const longOcrText = 'Signed service agreement between Example Client and Kuliberda Labs. '.repeat(4);
const documentAIStructuralScanLimit = 12_000;
const externalOnboardingSteps = ['offer_out', 'first_invoice', 'kickoff_booking', 'signed_document'];

function onboardingBody(overrides = {}) {
  return {
    deal_id: 'deal-contract-001',
    client_external_id: 'client-001',
    client_name: 'Ada Example',
    company: 'Example Client Sp. z o.o.',
    verified_email: 'ada@example.test',
    service_code: 'workflow_build',
    quantity: 2,
    request_details: 'Build and hand over the approved client workflow.',
    kickoff_slot_start: '2026-09-01T09:00:00Z',
    kickoff_slot_end: '2026-09-01T10:00:00Z',
    kickoff_slot_tz: 'UTC',
    filename: 'signed-agreement.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'attachment-001',
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
    ...overrides,
  };
}

function normalizeOnboarding(body) {
  return executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: { body },
  }).json;
}

function plannedSteps(result) {
  return JSON.parse(result.planned_steps_json);
}

function plannedStep(result, name) {
  const matches = plannedSteps(result).filter((step) => step.step_name === name);
  assert.equal(matches.length, 1, `expected one planned ${name} step`);
  return matches[0];
}

function normalizeInvoice(request) {
  return executeCodeNode(invoiceWorkflow, 'Normalize Completion Event', {
    input: { body: request },
  }).json;
}

function normalizeDocument(request) {
  return executeCodeNode(documentWorkflow, 'Normalize Document Intake', {
    input: { body: request },
  }).json;
}

function documentClaimKey(row) {
  return [row.document_key, row.onboarding_id || '', row.smoke_tag || ''].join('\n');
}

function validDocumentAI(overrides = {}) {
  return {
    document_type: 'Invoice',
    party_name: 'Example Supplier Sp. z o.o.',
    document_date: '2026-01-15',
    amount_total: 100,
    currency: 'PLN',
    confidence: 0.99,
    field_confidence: {
      document_type: 0.99,
      party_name: 0.99,
      document_date: 0.99,
      amount_total: 0.99,
    },
    needs_human_review: false,
    review_reason: '',
    evidence: {},
    ...overrides,
  };
}

function validDocumentAIJsonWithTrailingWhitespace(length) {
  const json = JSON.stringify(validDocumentAI());
  assert.ok(length >= json.length, `AI JSON length must be at least ${json.length}`);
  const padded = json.padEnd(length, ' ');
  assert.equal(padded.length, length);
  return padded;
}

function validDocumentAIFencedTextAtLength(length) {
  const json = JSON.stringify(validDocumentAI());
  const prefix = '```json\n';
  const suffix = '\n```';
  const paddingLength = length - prefix.length - json.length - suffix.length;
  assert.ok(paddingLength >= 0, `fenced AI text length must be at least ${prefix.length + json.length + suffix.length}`);
  const fenced = `${prefix}${json}${' '.repeat(paddingLength)}${suffix}`;
  assert.equal(fenced.length, length);
  return fenced;
}

function validateDocumentAI(ai) {
  const base = normalizeDocument({
    filename: 'typed-ai-output.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'typed-ai-output-attachment',
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  });
  assert.equal(base.status, 'AI Pending');
  return executeCodeNode(documentWorkflow, 'Validate AI Extraction', {
    input: ai,
    nodeOutputs: { 'Normalize Document Intake': base },
  }).json;
}

function documentAIDecisionRoute(result) {
  const workflow = loadWorkflow(documentWorkflow);
  const decision = workflow.nodes.find((node) => node.name === 'AI Validated Auto File?');
  const conditions = decision.parameters.conditions;
  assert.equal(conditions.options.typeValidation, 'strict');
  assert.equal(conditions.conditions.length, 1);
  const condition = conditions.conditions[0];
  assert.equal(condition.leftValue, '={{ $("Validate AI Extraction").item.json.auto_file }}');
  assert.deepEqual(condition.operator, { type: 'boolean', operation: 'true' });
  assert.equal(condition.rightValue, true);
  assert.equal(typeof result.auto_file, 'boolean');
  const branch = result.auto_file === condition.rightValue ? 0 : 1;
  return (workflow.connections[decision.name].main[branch] || []).map((edge) => edge.node);
}

for (const fixture of [
  { onboarding: 'ai_audit', invoice: 'automation_audit', quantity: 1 },
  { onboarding: 'automation_retainer', invoice: 'support_retainer', quantity: 6 },
  { onboarding: 'workflow_build', invoice: 'workflow_build', quantity: 3 },
]) {
  test(`onboarding ${fixture.onboarding} emits a completion accepted by the actual invoice normalizer`, () => {
    const normalized = normalizeOnboarding(onboardingBody({
      deal_id: `deal-${fixture.onboarding}`,
      service_code: fixture.onboarding,
      quantity: fixture.quantity,
    }));
    assert.equal(normalized.ok, true);
    const step = plannedStep(normalized, 'first_invoice');
    const request = JSON.parse(step.request_snapshot_bytes);
    assert.equal(step.state, 'INTENT_WRITTEN');
    assert.equal(request.event_type, 'job.completed');
    assert.equal(request.status, 'completed');
    assert.equal(request.quantity, fixture.quantity);
    assert.equal(request.service_code, fixture.invoice);
    assert.equal(request.job_id, `${normalized.onboarding_id}:first_invoice`);
    assert.equal(request.client_name, 'Ada Example');
    assert.equal(request.company, 'Example Client Sp. z o.o.');
    assert.equal(request.verified_email, 'ada@example.test');

    const child = normalizeInvoice(request);
    const expectedInvoiceKey = crypto
      .createHash('sha256')
      .update(`invoice.v1\n${request.job_id}`)
      .digest('hex');
    assert.equal(child.valid_input, true, child.review_reason);
    assert.equal(child.ignored_non_completion, false);
    assert.equal(child.real_invoice_key, expectedInvoiceKey);
    assert.equal(child.invoice_key, expectedInvoiceKey);
    assert.equal(step.predicted_child_key, expectedInvoiceKey);
  });
}

test('invoice price-book quantity bounds fail closed before a child intent is dispatchable', () => {
  for (const fixture of [
    { service_code: 'ai_audit', quantity: 2 },
    { service_code: 'automation_retainer', quantity: 7 },
    { service_code: 'workflow_build', quantity: 4 },
  ]) {
    const normalized = normalizeOnboarding(onboardingBody(fixture));
    const step = plannedStep(normalized, 'first_invoice');
    assert.equal(step.state, 'PRECONDITION_FAILED', JSON.stringify(fixture));
    assert.match(step.blocked_reason, /quantity/i);
    assert.equal(step.predicted_child_key, '');
  }
});

test('ops_sprint is explicitly non-dispatchable without guessed invoice mapping or pricing', () => {
  const normalized = normalizeOnboarding(onboardingBody({ service_code: 'ops_sprint', quantity: 1 }));
  const step = plannedStep(normalized, 'first_invoice');
  const request = JSON.parse(step.request_snapshot_bytes);
  assert.equal(step.state, 'PRECONDITION_FAILED');
  assert.match(step.blocked_reason, /unsupported_invoice_service_code/);
  assert.equal(step.predicted_child_key, '');
  assert.equal(request.service_code, '');
  assert.equal(request.quantity, 1);
});

test('onboarding emits attachment and hash document contracts accepted by the actual document normalizer', () => {
  const variants = [
    { attachment_id: 'attachment-contract-1', file_sha256: '' },
    { attachment_id: '', file_sha256: 'a'.repeat(64) },
  ];
  for (const variant of variants) {
    const normalized = normalizeOnboarding(onboardingBody(variant));
    const step = plannedStep(normalized, 'signed_document');
    const request = JSON.parse(step.request_snapshot_bytes);
    const child = normalizeDocument(request);
    assert.equal(step.state, 'INTENT_WRITTEN');
    assert.equal(child.invalid_input, false, child.review_reason);
    assert.equal(child.ocr_usable, true);
    assert.equal(step.predicted_child_key, child.document_key);
  }
});

test('all external child snapshots carry exact owner and run tag while business keys stay tag-independent', () => {
  const body = onboardingBody({ deal_id: 'child-run-scope-contract' });
  const normal = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: { body },
    vars: { ONBOARDING_SMOKE_TAG: 'PROD-SCOPE' },
  }).json;
  const fixture = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: {
      body: { ...body, test_mode: true, smoke_tag: 'TEST-FIX-SCOPE', child_fixtures: {} },
      headers: { 'x-onboarding-test-mode': 'fixtures' },
    },
    vars: { ONBOARDING_SMOKE_TAG: 'PROD-SCOPE', ONBOARDING_ALLOW_TEST_OVERRIDES: 'true' },
  }).json;

  assert.equal(normal.ok, true);
  assert.equal(fixture.ok, true);
  for (const stepName of ['offer_out', 'first_invoice', 'kickoff_booking', 'signed_document']) {
    const normalStep = plannedStep(normal, stepName);
    const fixtureStep = plannedStep(fixture, stepName);
    const normalRequest = JSON.parse(normalStep.request_snapshot_bytes);
    const fixtureRequest = JSON.parse(fixtureStep.request_snapshot_bytes);
    assert.equal(normalRequest.onboarding_id, normal.onboarding_id, stepName);
    assert.equal(fixtureRequest.onboarding_id, fixture.onboarding_id, stepName);
    assert.equal(normalRequest.smoke_tag, 'PROD-SCOPE', stepName);
    assert.equal(fixtureRequest.smoke_tag, 'TEST-FIX-SCOPE', stepName);
    assert.equal(normalStep.predicted_child_key, fixtureStep.predicted_child_key, stepName);
    assert.notEqual(normalStep.request_snapshot_hash, fixtureStep.request_snapshot_hash, stepName);
    assert.notEqual(normalStep.step_key, fixtureStep.step_key, stepName);
  }

  const normalInvoiceRequest = JSON.parse(plannedStep(normal, 'first_invoice').request_snapshot_bytes);
  const fixtureInvoiceRequest = JSON.parse(plannedStep(fixture, 'first_invoice').request_snapshot_bytes);
  const normalizedInvoice = normalizeInvoice(normalInvoiceRequest);
  const normalizedFixtureInvoice = normalizeInvoice(fixtureInvoiceRequest);
  assert.equal(normalizedInvoice.onboarding_id, normal.onboarding_id);
  assert.equal(normalizedInvoice.smoke_tag, 'PROD-SCOPE');
  assert.equal(normalizedFixtureInvoice.onboarding_id, fixture.onboarding_id);
  assert.equal(normalizedFixtureInvoice.smoke_tag, 'TEST-FIX-SCOPE');
  assert.equal(normalizedInvoice.invoice_key, normalizedFixtureInvoice.invoice_key);
  const invoiceClaims = {};
  assert.equal(executeCodeNode(invoiceWorkflow, 'Claim Completion Side Effect', {
    input: normalizedInvoice,
    workflowStaticData: invoiceClaims,
  }).json.duplicate_claim, false);
  assert.equal(executeCodeNode(invoiceWorkflow, 'Claim Completion Side Effect', {
    input: normalizedFixtureInvoice,
    workflowStaticData: invoiceClaims,
  }).json.duplicate_claim, false);

  const normalDocumentRequest = JSON.parse(plannedStep(normal, 'signed_document').request_snapshot_bytes);
  const fixtureDocumentRequest = JSON.parse(plannedStep(fixture, 'signed_document').request_snapshot_bytes);
  const normalizedDocument = normalizeDocument(normalDocumentRequest);
  const normalizedFixtureDocument = normalizeDocument(fixtureDocumentRequest);
  assert.equal(normalizedDocument.smoke_tag, 'PROD-SCOPE');
  assert.equal(normalizedFixtureDocument.smoke_tag, 'TEST-FIX-SCOPE');
  assert.equal(normalizedDocument.document_key, normalizedFixtureDocument.document_key);
  const documentClaims = {};
  assert.equal(executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: normalizedDocument,
    workflowStaticData: documentClaims,
  }).json.duplicate_claim, false);
  assert.equal(executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: normalizedFixtureDocument,
    workflowStaticData: documentClaims,
  }).json.duplicate_claim, false);
});

test('server smoke tags are validated without normalization before any external child becomes dispatchable', () => {
  const body = onboardingBody({ deal_id: 'raw-server-smoke-tag-contract' });
  const validTag = 'TEST-FIX-RAW';
  const valid = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: { body },
    vars: { ONBOARDING_SMOKE_TAG: validTag },
  }).json;

  assert.equal(valid.ok, true);
  assert.equal(valid.smoke_tag, validTag);
  for (const stepName of externalOnboardingSteps) {
    const step = plannedStep(valid, stepName);
    assert.equal(step.state, 'INTENT_WRITTEN', stepName);
    assert.ok(step.predicted_child_key, stepName);
    assert.equal(step.smoke_tag, validTag, stepName);
    assert.equal(JSON.parse(step.request_snapshot_bytes).smoke_tag, validTag, stepName);
  }

  for (const vars of [{}, { ONBOARDING_SMOKE_TAG: '' }]) {
    const defaulted = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
      input: { body },
      vars,
    }).json;
    assert.equal(defaulted.ok, true);
    assert.equal(defaulted.smoke_tag, 'ONBOARDING-DRAFT');
  }

  for (const fixture of [
    { name: 'supplied undefined', tag: undefined },
    { name: 'non-string', tag: 7 },
    { name: 'padded', tag: ` ${validTag} ` },
    { name: 'embedded whitespace', tag: 'TEST-FIX RAW' },
    { name: 'control character', tag: 'TEST-FIX-\u0000RAW' },
    { name: 'over 80 raw characters', tag: 'S'.repeat(81) },
  ]) {
    const invalid = executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
      input: { body },
      vars: { ONBOARDING_SMOKE_TAG: fixture.tag },
    }).json;

    assert.equal(invalid.ok, false, fixture.name);
    assert.ok(invalid.errors.includes('bad_server_smoke_tag'), fixture.name);
    for (const stepName of externalOnboardingSteps) {
      const step = plannedStep(invalid, stepName);
      assert.equal(step.state, 'PRECONDITION_FAILED', `${fixture.name}:${stepName}`);
      assert.equal(step.predicted_child_key, '', `${fixture.name}:${stepName}`);
      assert.notEqual(step.step_key, plannedStep(valid, stepName).step_key, `${fixture.name}:${stepName}`);
      assert.notEqual(step.request_snapshot_bytes, plannedStep(valid, stepName).request_snapshot_bytes, `${fixture.name}:${stepName}`);
    }
  }
});

test('enabled fixture smoke tags are validated raw while disabled overrides ignore caller controls', () => {
  const body = onboardingBody({ deal_id: 'raw-fixture-smoke-tag-contract' });
  const validTag = 'TEST-FIX-RAW';
  const executeFixture = (smokeTag, allow = 'true') => executeCodeNode(onboardingWorkflow, 'Normalize Onboarding', {
    input: {
      body: { ...body, test_mode: true, smoke_tag: smokeTag, child_fixtures: {} },
      headers: { 'x-onboarding-test-mode': 'fixtures' },
    },
    vars: { ONBOARDING_SMOKE_TAG: 'PROD-SCOPE', ONBOARDING_ALLOW_TEST_OVERRIDES: allow },
  }).json;
  const valid = executeFixture(validTag);

  assert.equal(valid.ok, true);
  assert.equal(valid.smoke_tag, validTag);
  for (const stepName of externalOnboardingSteps) {
    const step = plannedStep(valid, stepName);
    assert.equal(step.state, 'INTENT_WRITTEN', stepName);
    assert.ok(step.predicted_child_key, stepName);
    assert.equal(step.smoke_tag, validTag, stepName);
    assert.equal(JSON.parse(step.request_snapshot_bytes).smoke_tag, validTag, stepName);
  }

  for (const fixture of [
    { name: 'non-string', tag: { value: validTag } },
    { name: 'padded', tag: ` ${validTag} ` },
    { name: 'embedded whitespace', tag: 'TEST-FIX RAW' },
    { name: 'control character', tag: 'TEST-FIX-\u0000RAW' },
    { name: 'over fixture bound', tag: `TEST-FIX${'A'.repeat(65)}` },
  ]) {
    const invalid = executeFixture(fixture.tag);

    assert.equal(invalid.ok, false, fixture.name);
    assert.ok(invalid.errors.includes('bad_test_smoke_tag'), fixture.name);
    for (const stepName of externalOnboardingSteps) {
      const step = plannedStep(invalid, stepName);
      assert.equal(step.state, 'PRECONDITION_FAILED', `${fixture.name}:${stepName}`);
      assert.equal(step.predicted_child_key, '', `${fixture.name}:${stepName}`);
      assert.notEqual(step.step_key, plannedStep(valid, stepName).step_key, `${fixture.name}:${stepName}`);
      assert.notEqual(step.request_snapshot_bytes, plannedStep(valid, stepName).request_snapshot_bytes, `${fixture.name}:${stepName}`);
    }
  }

  const disabled = executeFixture(` ${validTag} `, 'false');
  assert.equal(disabled.ok, true);
  assert.equal(disabled.test_overrides_enabled, false);
  assert.equal(disabled.smoke_tag, 'PROD-SCOPE');
  for (const stepName of externalOnboardingSteps) {
    assert.equal(JSON.parse(plannedStep(disabled, stepName).request_snapshot_bytes).smoke_tag, 'PROD-SCOPE', stepName);
  }
});

test('controlled invoice and document tables persist and deduplicate by exact child evidence scope', () => {
  const invoice = loadWorkflow(invoiceWorkflow);
  const document = loadWorkflow(documentWorkflow);
  const nodes = (workflow) => new Map(workflow.nodes.map((node) => [node.name, node]));
  const invoiceNodes = nodes(invoice);
  const documentNodes = nodes(document);
  const filterKeys = (node) => (node.parameters.filters?.conditions || []).map((condition) => condition.keyName);
  const mappedKeys = (node) => Object.keys(node.parameters.columns?.value || {});
  const schemaKeys = (node) => (node.parameters.columns?.schema || []).map((field) => field.id);

  for (const name of ['Find Claimed Completion Row', 'Find Existing Invoice Row']) {
    assert.deepEqual(filterKeys(invoiceNodes.get(name)), ['invoice_key', 'onboarding_id', 'smoke_tag'], name);
  }
  for (const name of ['Find Dunning Recheck Row', 'Find Escalation Recheck Row']) {
    assert.deepEqual(filterKeys(invoiceNodes.get(name)), ['invoice_key', 'onboarding_id', 'smoke_tag'], name);
  }
  for (const name of ['Find Duplicate Payment Invoice Row', 'Find New Payment Invoice Row']) {
    assert.deepEqual(filterKeys(invoiceNodes.get(name)), ['invoice_key'], name);
    assert.equal(invoiceNodes.get(name).parameters.returnAll, true, name);
    assert.equal(invoiceNodes.get(name).parameters.limit, undefined, name);
  }
  assert.equal(invoiceNodes.has('Resolve Duplicate Payment Invoice Scope'), true);
  assert.equal(invoiceNodes.has('Resolve New Payment Invoice Scope'), true);
  assert.deepEqual(
    invoice.connections['Find Duplicate Payment Invoice Row'].main[0].map((edge) => edge.node),
    ['Resolve Duplicate Payment Invoice Scope'],
  );
  assert.deepEqual(
    invoice.connections['Resolve Duplicate Payment Invoice Scope'].main[0].map((edge) => edge.node),
    ['Duplicate Payment Invoice Missing?'],
  );
  assert.deepEqual(
    invoice.connections['Find New Payment Invoice Row'].main[0].map((edge) => edge.node),
    ['Resolve New Payment Invoice Scope'],
  );
  assert.deepEqual(
    invoice.connections['Resolve New Payment Invoice Scope'].main[0].map((edge) => edge.node),
    ['New Payment Invoice Missing?'],
  );
  for (const name of ['Insert Completion Dead Letter', 'Insert Invoice Pending Email']) {
    for (const field of ['invoice_key', 'onboarding_id', 'smoke_tag']) {
      assert.ok(mappedKeys(invoiceNodes.get(name)).includes(field), `${name}:${field}:mapping`);
      assert.ok(schemaKeys(invoiceNodes.get(name)).includes(field), `${name}:${field}:schema`);
    }
  }

  for (const name of ['Find Claimed Document Row', 'Find Existing Document Row']) {
    assert.deepEqual(filterKeys(documentNodes.get(name)), ['document_key', 'onboarding_id', 'smoke_tag'], name);
  }
  for (const name of [
    'Insert Document Dead Letter',
    'Insert Filed Document Record',
    'Insert AI Needs Review',
    'Insert OCR Needs Review',
  ]) {
    for (const field of ['document_key', 'onboarding_id', 'smoke_tag']) {
      assert.ok(mappedKeys(documentNodes.get(name)).includes(field), `${name}:${field}:mapping`);
      assert.ok(schemaKeys(documentNodes.get(name)).includes(field), `${name}:${field}:schema`);
    }
  }
});

test('controlled child run tags are preserved byte-for-byte and reject surrounding whitespace', () => {
  const normalized = normalizeOnboarding(onboardingBody({ deal_id: 'exact-child-tag-contract' }));
  const invoiceRequest = JSON.parse(plannedStep(normalized, 'first_invoice').request_snapshot_bytes);
  const documentRequest = JSON.parse(plannedStep(normalized, 'signed_document').request_snapshot_bytes);

  const exactInvoice = normalizeInvoice({ ...invoiceRequest, smoke_tag: 'TEST-FIX.Exact_1' });
  const spacedInvoice = normalizeInvoice({ ...invoiceRequest, smoke_tag: ' TEST-FIX.Exact_1 ' });
  assert.equal(exactInvoice.valid_input, true);
  assert.equal(exactInvoice.smoke_tag, 'TEST-FIX.Exact_1');
  assert.equal(spacedInvoice.valid_input, false);
  assert.equal(spacedInvoice.smoke_tag, '');

  const exactDocument = normalizeDocument({ ...documentRequest, smoke_tag: 'TEST-FIX.Exact_1' });
  const spacedDocument = normalizeDocument({ ...documentRequest, smoke_tag: ' TEST-FIX.Exact_1 ' });
  assert.equal(exactDocument.invalid_input, false);
  assert.equal(exactDocument.smoke_tag, 'TEST-FIX.Exact_1');
  assert.equal(spacedDocument.invalid_input, true);
  assert.equal(spacedDocument.smoke_tag, '');

  const spacedPayment = executeCodeNode(invoiceWorkflow, 'Normalize Payment Event', {
    input: { body: {
      event_type: 'invoice.paid',
      event_id: 'spaced-tag-payment',
      invoice_key: exactInvoice.invoice_key,
      smoke_tag: ' TEST-FIX.Exact_1 ',
    } },
  }).json;
  assert.equal(spacedPayment.valid_input, false);
  assert.equal(spacedPayment.smoke_tag, '');
});

test('invalid completion persistence cannot poison a corrected invoice identity or claim cache', () => {
  const workflow = loadWorkflow(invoiceWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const next = (name, branch = 0) => {
    const edges = workflow.connections[name]?.main?.[branch] || [];
    assert.equal(edges.length, 1, `${name}:${branch} must have one production successor`);
    return edges[0].node;
  };
  const filterKeys = (name) => (
    nodesByName.get(name).parameters.filters?.conditions || []
  ).map((condition) => condition.keyName);
  const persistentMatch = (name, normalized, rows) => {
    const keys = filterKeys(name);
    return rows.find((row) => keys.every((key) => row[key] === normalized[key]));
  };
  const executeProductionDuplicateRoute = (normalized, workflowStaticData, rows) => {
    const path = ['Claim Completion Side Effect'];
    const claim = executeCodeNode(invoiceWorkflow, 'Claim Completion Side Effect', {
      input: normalized,
      workflowStaticData,
    }).json;
    path.push(next('Claim Completion Side Effect'));
    if (claim.duplicate_claim) {
      path.push(next('Completion Claim Duplicate?', 0));
      const persistentRecord = persistentMatch('Find Claimed Completion Row', normalized, rows);
      path.push(next('Find Claimed Completion Row'));
      return { claim, path, persistentRecord };
    }
    path.push(next('Completion Claim Duplicate?', 1));
    const existing = persistentMatch('Find Existing Invoice Row', normalized, rows);
    path.push(next('Find Existing Invoice Row'));
    if (existing) {
      path.push(next('Persistent Invoice Duplicate?', 0));
      return { claim, path, persistentRecord: existing };
    }
    path.push(next('Persistent Invoice Duplicate?', 1));
    const invalidBranch = normalized.valid_input === false ? 0 : 1;
    path.push(next('Completion Invalid?', invalidBranch));
    if (normalized.valid_input) path.push(next('Insert Invoice Pending Email'));
    else {
      path.push(next('Insert Completion Dead Letter'));
      path.push(next('Mark Completion Claim Dead Letter'));
    }
    return { claim, path, persistentRecord: null };
  };

  for (const name of ['Find Claimed Completion Row', 'Find Existing Invoice Row']) {
    const conditions = nodesByName.get(name).parameters.filters.conditions;
    assert.deepEqual(filterKeys(name), ['invoice_key', 'onboarding_id', 'smoke_tag'], name);
    assert.deepEqual(conditions.map((condition) => condition.keyValue), [
      '={{ $("Normalize Completion Event").item.json.invoice_key }}',
      '={{ $("Normalize Completion Event").item.json.onboarding_id }}',
      '={{ $("Normalize Completion Event").item.json.smoke_tag }}',
    ], name);
  }
  assert.deepEqual(
    nodesByName.get('Completion Invalid?').parameters.conditions.conditions[0],
    {
      leftValue: '={{ $("Normalize Completion Event").item.json.valid_input }}',
      operator: { type: 'boolean', operation: 'false' },
      rightValue: false,
    },
  );
  assert.equal(
    nodesByName.get('Insert Completion Dead Letter').parameters.columns.value.invoice_key,
    '={{ $json.invoice_key }}',
  );
  assert.equal(
    nodesByName.get('Insert Invoice Pending Email').parameters.columns.value.invoice_key,
    '={{ $json.invoice_key }}',
  );
  assert.deepEqual(
    [next('Completion Claim Duplicate?', 0), next('Completion Claim Duplicate?', 1)],
    ['Find Claimed Completion Row', 'Find Existing Invoice Row'],
  );
  assert.deepEqual(
    [next('Persistent Invoice Duplicate?', 0), next('Persistent Invoice Duplicate?', 1)],
    ['Respond Invoice Duplicate', 'Completion Invalid?'],
  );
  assert.deepEqual(
    [next('Completion Invalid?', 0), next('Completion Invalid?', 1)],
    ['Insert Completion Dead Letter', 'Insert Invoice Pending Email'],
  );
  assert.equal(next('Insert Completion Dead Letter'), 'Mark Completion Claim Dead Letter');
  assert.equal(next('Mark Completion Claim Dead Letter'), 'Respond Completion Dead Letter');
  assert.equal(next('Insert Invoice Pending Email'), 'Send Controlled Invoice Email');

  const base = {
    event_type: 'job.completed',
    status: 'completed',
    client_name: 'Ada Example',
    company: 'Example Client Sp. z o.o.',
    verified_email: 'ada@example.test',
    service_code: 'workflow_build',
    quantity: 1,
    completed_at: '2026-08-10T10:00:00.000Z',
  };
  const invalidVariants = [
    ['malformed owner', { onboarding_id: 'not-a-valid-owner' }],
    ['malformed tag', { smoke_tag: ' TEST-FIX-POISON ' }],
    ['invalid service', { service_code: 'not_in_price_book' }],
    ['invalid quantity', { quantity: 4 }],
    ['invalid email', { verified_email: 'not-an-email' }],
  ];

  for (const [name, invalidFields] of invalidVariants) {
    const job_id = `claim-poison-${name.replace(/\s+/g, '-')}`;
    const malformedRequest = {
      ...base,
      job_id,
      event_id: `${job_id}-event`,
      ...invalidFields,
    };
    const correctedRequest = {
      ...base,
      job_id,
      event_id: `${job_id}-event`,
    };
    const malformed = normalizeInvoice(malformedRequest);
    const malformedReplay = normalizeInvoice(malformedRequest);
    const corrected = normalizeInvoice(correctedRequest);
    const validInvoiceKey = crypto.createHash('sha256')
      .update(`invoice.v1\n${job_id}`)
      .digest('hex');
    const invalidPersistenceKey = crypto.createHash('sha256')
      .update(`invoice.dead.v1\n${malformed.raw_event_json}`)
      .digest('hex');
    const workflowStaticData = {};
    const rows = [];
    let deadLetterInsertCount = 0;
    let invoiceInsertCount = 0;
    let invoiceSendCount = 0;

    assert.equal(corrected.valid_input, true, name);
    assert.equal(corrected.invoice_key, validInvoiceKey, name);
    assert.equal(corrected.real_invoice_key, validInvoiceKey, name);
    assert.equal(corrected.onboarding_id, '', name);
    assert.equal(corrected.smoke_tag, '', name);

    const firstMalformed = executeProductionDuplicateRoute(malformed, workflowStaticData, rows);
    assert.equal(firstMalformed.claim.duplicate_claim, false, name);
    assert.equal(firstMalformed.path.includes('Insert Completion Dead Letter'), true, name);
    assert.equal(firstMalformed.path.includes('Insert Invoice Pending Email'), false, name);
    const staticDataAfterInvalidClaim = structuredClone(workflowStaticData);
    deadLetterInsertCount += 1;
    const deadLetterRecord = { ...malformed, id: `dead-letter-${name}` };
    rows.push(deadLetterRecord);
    executeCodeNode(invoiceWorkflow, 'Mark Completion Claim Dead Letter', {
      input: deadLetterRecord,
      nodeOutputs: { 'Normalize Completion Event': malformed },
      workflowStaticData,
    });
    assert.equal(malformed.valid_input, false, name);
    assert.equal(malformed.status, 'Dead Letter', name);
    assert.equal(malformed.real_invoice_key, validInvoiceKey, name);
    assert.equal(malformed.invoice_key, invalidPersistenceKey, name);
    assert.equal(malformedReplay.invoice_key, invalidPersistenceKey, name);
    assert.notEqual(malformed.invoice_key, validInvoiceKey, name);
    assert.deepEqual(staticDataAfterInvalidClaim, {}, `${name}: invalid claim must not create static state`);
    assert.deepEqual(workflowStaticData, {}, `${name}: invalid finalizer must not mutate static state`);

    const persistentMalformedReplay = executeProductionDuplicateRoute(
      malformedReplay,
      workflowStaticData,
      rows,
    );
    assert.equal(persistentMalformedReplay.claim.duplicate_claim, false, name);
    assert.equal(persistentMalformedReplay.persistentRecord.id, `dead-letter-${name}`, name);
    assert.equal(persistentMalformedReplay.path.at(-1), 'Respond Invoice Duplicate', name);
    assert.equal(persistentMalformedReplay.path.includes('Insert Completion Dead Letter'), false, name);

    const firstCorrected = executeProductionDuplicateRoute(corrected, workflowStaticData, rows);
    assert.equal(firstCorrected.claim.duplicate_claim, false, name);
    assert.equal(firstCorrected.path.includes('Insert Invoice Pending Email'), true, name);
    assert.equal(firstCorrected.path.includes('Send Controlled Invoice Email'), true, name);
    invoiceInsertCount += 1;
    invoiceSendCount += 1;
    rows.push({ ...corrected, id: `invoice-${name}` });

    const correctedReplay = executeProductionDuplicateRoute(corrected, workflowStaticData, rows);
    assert.equal(correctedReplay.claim.duplicate_claim, true, name);
    assert.equal(correctedReplay.persistentRecord.id, `invoice-${name}`, name);
    assert.equal(correctedReplay.path.at(-1), 'Respond Invoice Duplicate', name);
    assert.equal(correctedReplay.path.includes('Insert Invoice Pending Email'), false, name);
    assert.equal(correctedReplay.path.includes('Send Controlled Invoice Email'), false, name);
    assert.equal(deadLetterInsertCount, 1, name);
    assert.equal(invoiceInsertCount, 1, name);
    assert.equal(invoiceSendCount, 1, name);
  }

  const ignoredRequest = {
    ...base,
    event_type: 'job.created',
    status: 'scheduled',
    job_id: 'ignored-event-invalid-namespace',
    event_id: 'ignored-event-invalid-namespace-event',
  };
  const ignored = normalizeInvoice(ignoredRequest);
  const ignoredPersistenceKey = crypto.createHash('sha256')
    .update(`invoice.dead.v1\n${ignored.raw_event_json}`)
    .digest('hex');
  const ignoredBusinessKey = crypto.createHash('sha256')
    .update(`invoice.v1\n${ignoredRequest.job_id}`)
    .digest('hex');
  const ignoredClaims = {};
  assert.equal(ignored.ignored_non_completion, true);
  assert.equal(ignored.valid_input, false);
  assert.equal(ignored.invoice_key, ignoredPersistenceKey);
  assert.notEqual(ignored.invoice_key, ignoredBusinessKey);
  assert.deepEqual(
    [next('Completion Event Ignored?', 0), next('Completion Event Ignored?', 1)],
    ['Respond Completion Ignored', 'Claim Completion Side Effect'],
  );
  executeCodeNode(invoiceWorkflow, 'Claim Completion Side Effect', {
    input: ignored,
    workflowStaticData: ignoredClaims,
  });
  assert.deepEqual(ignoredClaims, {});

  const stressClaims = {};
  const protectedValid = normalizeInvoice({
    ...base,
    job_id: 'claim-cache-protected-valid',
    event_id: 'claim-cache-protected-valid-event',
  });
  executeCodeNode(invoiceWorkflow, 'Claim Completion Side Effect', {
    input: protectedValid,
    workflowStaticData: stressClaims,
  });
  const protectedClaimKey = [protectedValid.invoice_key, '', ''].join('\n');
  const protectedClaimBytes = JSON.stringify(stressClaims.invoice_claims[protectedClaimKey]);
  for (let index = 0; index < 5001; index += 1) {
    const invalid = normalizeInvoice({
      ...base,
      job_id: `claim-cache-invalid-${index}`,
      event_id: `claim-cache-invalid-${index}-event`,
      smoke_tag: ` invalid-${index}`,
    });
    const claim = executeCodeNode(invoiceWorkflow, 'Claim Completion Side Effect', {
      input: invalid,
      workflowStaticData: stressClaims,
    }).json;
    executeCodeNode(invoiceWorkflow, 'Mark Completion Claim Dead Letter', {
      input: { ...invalid, id: `invalid-row-${index}` },
      nodeOutputs: { 'Normalize Completion Event': invalid },
      workflowStaticData: stressClaims,
    });
    assert.equal(invalid.valid_input, false, String(index));
    assert.equal(claim.duplicate_claim, false, String(index));
  }
  assert.deepEqual(Object.keys(stressClaims.invoice_claims), [protectedClaimKey]);
  assert.equal(JSON.stringify(stressClaims.invoice_claims[protectedClaimKey]), protectedClaimBytes);
});

test('tagged invoice payment and chase identities cannot select or claim another run scope', () => {
  const payment = executeCodeNode(invoiceWorkflow, 'Normalize Payment Event', {
    input: { body: {
      event_type: 'invoice.paid',
      event_id: 'payment-scope-event',
      job_id: `${'a'.repeat(64)}:first_invoice`,
      onboarding_id: 'a'.repeat(64),
      smoke_tag: 'TEST-FIX-PAYMENT',
    } },
  }).json;
  assert.equal(payment.valid_input, true);
  assert.equal(payment.onboarding_id, 'a'.repeat(64));
  assert.equal(payment.smoke_tag, 'TEST-FIX-PAYMENT');
  assert.equal(payment.onboarding_id_provided, true);
  assert.equal(payment.smoke_tag_provided, true);
  const paymentClaims = {};
  const firstPayment = executeCodeNode(invoiceWorkflow, 'Claim Payment Event', {
    input: payment,
    workflowStaticData: paymentClaims,
  }).json;
  const otherScopePayment = executeCodeNode(invoiceWorkflow, 'Claim Payment Event', {
    input: { ...payment, smoke_tag: 'PROD-SCOPE' },
    workflowStaticData: paymentClaims,
  }).json;
  assert.equal(firstPayment.payment_duplicate_claim, false);
  assert.equal(otherScopePayment.payment_duplicate_claim, false);
  assert.notEqual(firstPayment.payment_claim_key, otherScopePayment.payment_claim_key);

  const candidateRows = [
    { id: 'invoice-prod', invoice_key: payment.invoice_key, onboarding_id: payment.onboarding_id, smoke_tag: 'PROD-SCOPE' },
    { id: 'invoice-test', invoice_key: payment.invoice_key, onboarding_id: payment.onboarding_id, smoke_tag: 'TEST-FIX-PAYMENT' },
  ];
  const exact = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: candidateRows,
    nodeOutputs: { 'Normalize Payment Event': payment },
  }).json;
  assert.equal(exact.id, 'invoice-test');
  assert.equal(exact.payment_scope_unresolved, false);

  const legacyPayment = executeCodeNode(invoiceWorkflow, 'Normalize Payment Event', {
    input: { body: {
      event_type: 'invoice.paid',
      event_id: 'legacy-payment-scope-event',
      job_id: `${'a'.repeat(64)}:first_invoice`,
    } },
  }).json;
  const uniqueLegacy = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: [candidateRows[0]],
    nodeOutputs: { 'Normalize Payment Event': legacyPayment },
  }).json;
  assert.equal(legacyPayment.valid_input, true);
  assert.equal(legacyPayment.scope_explicit, false);
  assert.equal(uniqueLegacy.id, 'invoice-prod');
  const ambiguousLegacy = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: candidateRows,
    nodeOutputs: { 'Normalize Payment Event': legacyPayment },
  }).json;
  assert.equal(ambiguousLegacy.id, undefined);
  assert.equal(ambiguousLegacy.payment_scope_unresolved, true);
  assert.equal(ambiguousLegacy.total_candidate_count, 2);

  const ownerOnlyPayment = executeCodeNode(invoiceWorkflow, 'Normalize Payment Event', {
    input: { body: {
      event_type: 'invoice.paid',
      event_id: 'owner-only-payment-scope-event',
      job_id: `${'a'.repeat(64)}:first_invoice`,
      onboarding_id: 'a'.repeat(64),
    } },
  }).json;
  assert.equal(ownerOnlyPayment.onboarding_id_provided, true);
  assert.equal(ownerOnlyPayment.smoke_tag_provided, false);
  const uniqueOwnerOnly = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: [candidateRows[0], { ...candidateRows[1], onboarding_id: 'b'.repeat(64) }],
    nodeOutputs: { 'Normalize Payment Event': ownerOnlyPayment },
  }).json;
  assert.equal(uniqueOwnerOnly.id, 'invoice-prod');
  const ambiguousOwnerOnly = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: candidateRows,
    nodeOutputs: { 'Normalize Payment Event': ownerOnlyPayment },
  }).json;
  assert.equal(ambiguousOwnerOnly.id, undefined);
  assert.equal(ambiguousOwnerOnly.scope_candidate_count, 2);

  const tagOnlyPayment = executeCodeNode(invoiceWorkflow, 'Normalize Payment Event', {
    input: { body: {
      event_type: 'invoice.paid',
      event_id: 'tag-only-payment-scope-event',
      job_id: `${'a'.repeat(64)}:first_invoice`,
      smoke_tag: 'TEST-FIX-PAYMENT',
    } },
  }).json;
  assert.equal(tagOnlyPayment.onboarding_id_provided, false);
  assert.equal(tagOnlyPayment.smoke_tag_provided, true);
  const uniqueTagOnly = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: candidateRows,
    nodeOutputs: { 'Normalize Payment Event': tagOnlyPayment },
  }).json;
  assert.equal(uniqueTagOnly.id, 'invoice-test');
  const ambiguousTagOnly = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: [candidateRows[1], { ...candidateRows[0], smoke_tag: 'TEST-FIX-PAYMENT' }],
    nodeOutputs: { 'Normalize Payment Event': tagOnlyPayment },
  }).json;
  assert.equal(ambiguousTagOnly.id, undefined);
  assert.equal(ambiguousTagOnly.scope_candidate_count, 2);

  const dueAt = '2020-01-01T00:00:00.000Z';
  const invoiceRows = ['PROD-SCOPE', 'TEST-FIX-PAYMENT'].map((smoke_tag, index) => ({
    id: `invoice-row-${index}`,
    invoice_key: payment.invoice_key,
    onboarding_id: payment.onboarding_id,
    smoke_tag,
    status: 'Invoice Sent',
    paid_at: '',
    next_nudge_due_at: dueAt,
    completed_at: dueAt,
    nudge_count: 0,
    amount_gross_pln: 100,
  }));
  const actions = executeCodeNode(invoiceWorkflow, 'Build Due Dunning Actions', {
    inputRows: invoiceRows,
  }).map((item) => item.json);
  assert.equal(actions.length, 2);
  assert.notEqual(actions[0].action_key, actions[1].action_key);
});

test('inside-window payment replay resolves a late invoice before treating the event as duplicate', () => {
  const workflow = loadWorkflow(invoiceWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const next = (name, branch = 0) => {
    const edges = workflow.connections[name]?.main?.[branch] || [];
    assert.equal(edges.length, 1, `${name}:${branch} must have one production successor`);
    return edges[0].node;
  };
  const reachableFrom = (start) => {
    const seen = new Set();
    const pending = [start];
    while (pending.length) {
      const name = pending.pop();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      for (const branches of workflow.connections[name]?.main || []) {
        for (const edge of branches || []) pending.push(edge.node);
      }
    }
    return seen;
  };
  const payment = executeCodeNode(invoiceWorkflow, 'Normalize Payment Event', {
    input: { body: {
      event_type: 'invoice.paid',
      event_id: 'payment-before-invoice-event',
      job_id: `${'a'.repeat(64)}:first_invoice`,
      onboarding_id: 'a'.repeat(64),
      smoke_tag: 'TEST-LATE-INVOICE',
      paid_at: '2026-08-10T10:00:00.000Z',
    } },
  }).json;
  assert.equal(payment.valid_input, true);
  assert.equal(payment.onboarding_id_provided, true);
  assert.equal(payment.smoke_tag_provided, true);

  const paymentClaims = {};
  const firstClaim = executeCodeNode(invoiceWorkflow, 'Claim Payment Event', {
    input: payment,
    workflowStaticData: paymentClaims,
  }).json;
  assert.equal(firstClaim.payment_duplicate_claim, false);
  assert.equal(next('Payment Claim Duplicate?', 1), 'Find New Payment Invoice Row');

  const initiallyUnresolved = executeCodeNode(invoiceWorkflow, 'Resolve New Payment Invoice Scope', {
    inputRows: [],
    nodeOutputs: { 'Normalize Payment Event': payment },
  }).json;
  assert.equal(initiallyUnresolved.payment_scope_unresolved, true);
  assert.equal(initiallyUnresolved.scope_candidate_count, 0);
  assert.equal(next('New Payment Invoice Missing?', 0), 'Find Unmatched Payment Queue Row');
  assert.equal(reachableFrom('Find Unmatched Payment Queue Row').has('Build Paid Update'), false);

  paymentClaims.payment_claims[firstClaim.payment_claim_key].claimed_at = new Date(
    Date.now() - 14 * 60 * 1000,
  ).toISOString();
  const secondClaim = executeCodeNode(invoiceWorkflow, 'Claim Payment Event', {
    input: payment,
    workflowStaticData: paymentClaims,
  }).json;
  assert.equal(secondClaim.payment_duplicate_claim, true);
  assert.equal(next('Payment Claim Duplicate?', 0), 'Find Duplicate Payment Invoice Row');

  const sentInvoice = {
    id: 'late-invoice-row',
    invoice_key: payment.invoice_key,
    onboarding_id: payment.onboarding_id,
    smoke_tag: payment.smoke_tag,
    status: 'Invoice Sent',
    paid_at: '',
    next_nudge_due_at: '2020-01-01T00:00:00.000Z',
    completed_at: '2020-01-01T00:00:00.000Z',
    nudge_count: 0,
    amount_gross_pln: 100,
  };
  const resolvedReplay = executeCodeNode(invoiceWorkflow, 'Resolve Duplicate Payment Invoice Scope', {
    inputRows: [sentInvoice],
    nodeOutputs: { 'Normalize Payment Event': payment },
  }).json;
  assert.equal(resolvedReplay.id, sentInvoice.id);
  assert.equal(resolvedReplay.payment_scope_unresolved, false);
  assert.equal(next('Resolve Duplicate Payment Invoice Scope'), 'Duplicate Payment Invoice Missing?');
  assert.equal(next('Duplicate Payment Invoice Missing?', 1), 'Payment Already Paid?');
  assert.deepEqual(
    nodesByName.get('Payment Already Paid?').parameters.conditions.conditions[0],
    {
      leftValue: '={{ $json.status === "Paid" }}',
      operator: { type: 'boolean', operation: 'true' },
      rightValue: true,
    },
  );
  assert.equal(next('Payment Already Paid?', 1), 'Build Paid Update');
  assert.equal(next('Build Paid Update'), 'Update Invoice Paid');
  assert.equal(next('Update Invoice Paid'), 'Mark Payment Claim Paid');
  assert.notEqual(nodesByName.get('Update Invoice Paid').alwaysOutputData, true);

  const paidUpdate = executeCodeNode(invoiceWorkflow, 'Build Paid Update', {
    input: resolvedReplay,
    nodeOutputs: { 'Normalize Payment Event': payment },
  }).json;
  assert.equal(paidUpdate.id, sentInvoice.id);
  assert.equal(paidUpdate.status, 'Paid');
  assert.equal(paidUpdate.payment_event_id, payment.payment_event_id);
  const markedPaid = executeCodeNode(invoiceWorkflow, 'Mark Payment Claim Paid', {
    input: paidUpdate,
    nodeOutputs: { 'Claim Payment Event': secondClaim },
    workflowStaticData: paymentClaims,
  }).json;
  assert.deepEqual(markedPaid, paidUpdate);
  assert.equal(paymentClaims.payment_claims[firstClaim.payment_claim_key].status, 'Paid');
  assert.equal(executeCodeNode(invoiceWorkflow, 'Build Due Dunning Actions', {
    inputRows: [paidUpdate],
  }).length, 0);

  const thirdClaim = executeCodeNode(invoiceWorkflow, 'Claim Payment Event', {
    input: payment,
    workflowStaticData: paymentClaims,
  }).json;
  assert.equal(thirdClaim.payment_duplicate_claim, true);
  assert.equal(thirdClaim.duplicate_status, 'Paid');
  const alreadyPaid = executeCodeNode(invoiceWorkflow, 'Resolve Duplicate Payment Invoice Scope', {
    inputRows: [paidUpdate],
    nodeOutputs: { 'Normalize Payment Event': payment },
  }).json;
  assert.equal(alreadyPaid.status, 'Paid');
  assert.equal(next('Payment Already Paid?', 0), 'Respond Payment Duplicate');
  assert.equal(reachableFrom('Respond Payment Duplicate').has('Build Paid Update'), false);

  const staleClaims = {};
  const staleFirst = executeCodeNode(invoiceWorkflow, 'Claim Payment Event', {
    input: payment,
    workflowStaticData: staleClaims,
  }).json;
  staleClaims.payment_claims[staleFirst.payment_claim_key].claimed_at = new Date(
    Date.now() - 16 * 60 * 1000,
  ).toISOString();
  const staleReplay = executeCodeNode(invoiceWorkflow, 'Claim Payment Event', {
    input: payment,
    workflowStaticData: staleClaims,
  }).json;
  assert.equal(staleReplay.payment_duplicate_claim, false);

  const unresolvedDuplicate = executeCodeNode(invoiceWorkflow, 'Resolve Duplicate Payment Invoice Scope', {
    inputRows: [],
    nodeOutputs: { 'Normalize Payment Event': payment },
  }).json;
  const ambiguousDuplicate = executeCodeNode(invoiceWorkflow, 'Resolve Duplicate Payment Invoice Scope', {
    inputRows: [sentInvoice, { ...sentInvoice, id: 'second-late-invoice-row' }],
    nodeOutputs: { 'Normalize Payment Event': payment },
  }).json;
  assert.equal(unresolvedDuplicate.payment_scope_unresolved, true);
  assert.equal(ambiguousDuplicate.payment_scope_unresolved, true);
  assert.equal(next('Duplicate Payment Invoice Missing?', 0), 'Find Unmatched Payment Queue Row');
  assert.equal(reachableFrom(next('Duplicate Payment Invoice Missing?', 0)).has('Build Paid Update'), false);

  const paidPath = reachableFrom('Payment Already Paid?');
  const externalNodeTypes = [...paidPath]
    .map((name) => nodesByName.get(name)?.type || '')
    .filter((type) => type === 'n8n-nodes-base.gmail' || type.includes('openAi'));
  assert.deepEqual(externalNodeTypes, []);
});

test('duplicate payment resolver preserves exact owner and tag scope rules', () => {
  const jobId = `${'b'.repeat(64)}:first_invoice`;
  const ownerA = 'a'.repeat(64);
  const ownerB = 'b'.repeat(64);
  const rows = [
    { id: 'a-prod', onboarding_id: ownerA, smoke_tag: 'PROD-SCOPE' },
    { id: 'a-test', onboarding_id: ownerA, smoke_tag: 'TEST-SCOPE' },
    { id: 'b-test', onboarding_id: ownerB, smoke_tag: 'TEST-SCOPE' },
  ];
  const resolve = (eventId, scope, candidates) => {
    const payment = executeCodeNode(invoiceWorkflow, 'Normalize Payment Event', {
      input: { body: {
        event_type: 'invoice.paid',
        event_id: eventId,
        job_id: jobId,
        ...scope,
      } },
    }).json;
    const scopedRows = candidates.map((row) => ({ ...row, invoice_key: payment.invoice_key }));
    return executeCodeNode(invoiceWorkflow, 'Resolve Duplicate Payment Invoice Scope', {
      inputRows: scopedRows,
      nodeOutputs: { 'Normalize Payment Event': payment },
    }).json;
  };

  assert.equal(resolve('full-exact', { onboarding_id: ownerA, smoke_tag: 'TEST-SCOPE' }, rows).id, 'a-test');
  assert.equal(resolve('wrong-tag', { onboarding_id: ownerA, smoke_tag: 'WRONG-SCOPE' }, rows).payment_scope_unresolved, true);
  assert.equal(resolve('owner-unique', { onboarding_id: ownerB }, rows).id, 'b-test');
  assert.equal(resolve('owner-ambiguous', { onboarding_id: ownerA }, rows).payment_scope_unresolved, true);
  assert.equal(resolve('tag-unique', { smoke_tag: 'PROD-SCOPE' }, rows).id, 'a-prod');
  assert.equal(resolve('tag-ambiguous', { smoke_tag: 'TEST-SCOPE' }, rows).payment_scope_unresolved, true);
  assert.equal(resolve('blank-unique', {}, [rows[0]]).id, 'a-prod');
  assert.equal(resolve('blank-ambiguous', {}, rows).payment_scope_unresolved, true);
});

test('workflow 04 is not an onboarding booking producer', () => {
  const workflow = loadWorkflow(supportWorkflow);
  assert.equal(workflow.name, 'Support Triage + FAQ Draft (injection-hardened)');
  assert.equal(
    workflow.nodes.some((node) => node.parameters?.dataTableId?.cachedResultName === 'Bookings'),
    false,
  );
});

test('attachment document keys use an unambiguous shared serialization', () => {
  const shared = { deal_id: 'attachment-key-owner', file_sha256: '' };
  const first = normalizeOnboarding(onboardingBody({
    ...shared,
    attachment_id: 'alpha|beta',
    filename: 'contract.pdf',
  }));
  const second = normalizeOnboarding(onboardingBody({
    ...shared,
    attachment_id: 'alpha',
    filename: 'beta|contract.pdf',
  }));
  const firstReplay = normalizeOnboarding(onboardingBody({
    ...shared,
    attachment_id: 'alpha|beta',
    filename: 'contract.pdf',
  }));
  const firstStep = plannedStep(first, 'signed_document');
  const secondStep = plannedStep(second, 'signed_document');
  const firstRequest = JSON.parse(firstStep.request_snapshot_bytes);
  const secondRequest = JSON.parse(secondStep.request_snapshot_bytes);
  const firstChild = normalizeDocument(firstRequest);
  const secondChild = normalizeDocument(secondRequest);
  const claims = {};
  const firstClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: firstChild,
    workflowStaticData: claims,
  }).json;
  const secondClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: secondChild,
    workflowStaticData: claims,
  }).json;

  assert.equal(firstClaim.duplicate_claim, false);
  assert.equal(secondClaim.duplicate_claim, false);
  assert.notEqual(firstStep.request_snapshot_hash, secondStep.request_snapshot_hash);
  assert.notEqual(firstStep.step_key, secondStep.step_key);
  assert.notEqual(firstStep.predicted_child_key, secondStep.predicted_child_key);
  assert.equal(firstStep.predicted_child_key, firstChild.document_key);
  assert.equal(secondStep.predicted_child_key, secondChild.document_key);
  assert.equal(
    firstStep.predicted_child_key,
    crypto.createHash('sha256').update(
      `doc-intake\n${first.onboarding_id}\n${JSON.stringify(['attachment.v2', 'alpha|beta', 'contract.pdf', 'application/pdf'])}`,
    ).digest('hex'),
  );
  assert.equal(
    firstStep.predicted_child_key,
    plannedStep(firstReplay, 'signed_document').predicted_child_key,
  );

  const fileSha256 = '9'.repeat(64);
  const hashOwned = normalizeOnboarding(onboardingBody({
    ...shared,
    attachment_id: 'ignored-when-hash-valid',
    filename: 'hash-document.pdf',
    file_sha256: fileSha256,
  }));
  const hashStep = plannedStep(hashOwned, 'signed_document');
  const hashChild = normalizeDocument(JSON.parse(hashStep.request_snapshot_bytes));
  const legacyHashKey = crypto.createHash('sha256')
    .update(`doc-intake\n${hashOwned.onboarding_id}\n${fileSha256}`)
    .digest('hex');
  assert.equal(hashStep.predicted_child_key, legacyHashKey);
  assert.equal(hashChild.document_key, legacyHashKey);
});

test('unsupported MIME persistence cannot block a corrected same-file document', () => {
  const workflow = loadWorkflow(documentWorkflow);
  const node = (name) => workflow.nodes.find((candidate) => candidate.name === name);
  const next = (name, branch = 0) => (
    workflow.connections[name]?.main?.[branch] || []
  ).map((edge) => edge.node);
  const lookup = node('Find Existing Document Row');
  assert.equal(lookup.parameters.filters.conditions[0].keyName, 'document_key');
  assert.equal(lookup.parameters.filters.conditions[0].condition, 'eq');
  assert.equal(lookup.parameters.filters.conditions[0].keyValue, '={{ $("Normalize Document Intake").item.json.document_key }}');
  const duplicate = node('Persistent Document Duplicate?');
  assert.equal(duplicate.parameters.conditions.conditions[0].leftValue, '={{ !!$json.id }}');
  assert.deepEqual(next('Persistent Document Duplicate?', 0), ['Respond Document Duplicate']);
  assert.deepEqual(next('Persistent Document Duplicate?', 1), ['Document Intake Dead Letter?']);

  const persistentRoute = (normalized, persistedRows) => {
    const matched = persistedRows.find((row) => row.document_key === normalized.document_key) || {};
    return next('Persistent Document Duplicate?', matched.id ? 0 : 1);
  };
  const fileSha256 = '9'.repeat(64);
  const exactOwner = crypto.createHash('sha256').update('unsupported-mime-owner').digest('hex');
  for (const onboardingId of ['', exactOwner]) {
    const request = {
      filename: 'correctable-mime.pdf',
      mime_type: 'application/unsupported',
      file_sha256: fileSha256,
      ocr_text: longOcrText,
      ocr_confidence: 0.99,
      scan_text_ratio: 0.95,
      ...(onboardingId ? { onboarding_id: onboardingId } : {}),
    };
    const invalid = normalizeDocument(request);
    const invalidReplay = normalizeDocument(request);
    const corrected = normalizeDocument({ ...request, mime_type: 'application/pdf' });
    const scope = onboardingId ? `${onboardingId}\n` : '';
    const invalidSeed = JSON.stringify([
      'invalid-document.v1',
      'unsupported_mime',
      'application/unsupported',
      ['file-sha256.v1', fileSha256],
      '',
    ]);
    const expectedInvalidKey = crypto.createHash('sha256')
      .update(`doc-intake\n${scope}${invalidSeed}`)
      .digest('hex');
    const expectedCorrectedKey = crypto.createHash('sha256')
      .update(`doc-intake\n${scope}${fileSha256}`)
      .digest('hex');

    assert.equal(invalid.status, 'Dead Letter');
    assert.equal(invalid.last_error_class, 'permanent');
    assert.equal(invalid.document_key, invalidReplay.document_key);
    assert.equal(invalid.document_key, expectedInvalidKey);
    assert.notEqual(invalid.document_key, corrected.document_key);
    assert.equal(corrected.status, 'AI Pending');
    assert.equal(corrected.ocr_usable, true);
    assert.equal(corrected.document_key, expectedCorrectedKey);

    const persistedInvalid = [{ id: `dead-letter-${onboardingId || 'standalone'}`, document_key: invalid.document_key, status: 'Dead Letter' }];
    assert.deepEqual(persistentRoute(invalidReplay, persistedInvalid), ['Respond Document Duplicate']);
    assert.deepEqual(persistentRoute(corrected, persistedInvalid), ['Document Intake Dead Letter?']);
    assert.deepEqual(next('Document Intake Dead Letter?', corrected.status === 'Dead Letter' ? 0 : 1), ['OCR Usable?']);
    assert.deepEqual(next('OCR Usable?', corrected.status === 'AI Pending' && corrected.ocr_usable ? 0 : 1), ['Extract Document Fields']);
  }

  const attachmentRequest = {
    filename: 'correctable-attachment.pdf',
    mime_type: 'application/unsupported',
    attachment_id: 'correctable-attachment-id',
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const invalidAttachment = normalizeDocument(attachmentRequest);
  const correctedAttachment = normalizeDocument({ ...attachmentRequest, mime_type: 'application/pdf' });
  const expectedInvalidAttachmentKey = crypto.createHash('sha256')
    .update(`doc-intake\n${JSON.stringify([
      'invalid-document.v1',
      'unsupported_mime',
      'application/unsupported',
      ['attachment.v1', attachmentRequest.attachment_id, attachmentRequest.filename],
      '',
    ])}`)
    .digest('hex');
  const expectedValidAttachmentKey = crypto.createHash('sha256')
    .update(`doc-intake\n${JSON.stringify(['attachment.v2', attachmentRequest.attachment_id, attachmentRequest.filename, 'application/pdf'])}`)
    .digest('hex');
  assert.equal(invalidAttachment.document_key, expectedInvalidAttachmentKey);
  assert.equal(correctedAttachment.document_key, expectedValidAttachmentKey);
  assert.notEqual(invalidAttachment.document_key, correctedAttachment.document_key);
});

test('document contract fields require bounded strings before key dispatch', () => {
  const owner = normalizeOnboarding(onboardingBody({ deal_id: 'strict-document-owner' })).onboarding_id;
  const directBase = {
    onboarding_id: owner,
    filename: 'strict-document.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'strict-attachment',
    file_sha256: '',
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const objectFirst = normalizeDocument({ ...directBase, attachment_id: { tenant: 'alpha' } });
  const objectSecond = normalizeDocument({ ...directBase, attachment_id: { tenant: 'beta' } });
  assert.equal(objectFirst.invalid_input, true);
  assert.equal(objectSecond.invalid_input, true);
  assert.equal(objectFirst.status, 'Dead Letter');
  assert.equal(objectSecond.status, 'Dead Letter');
  assert.notEqual(objectFirst.document_key, objectSecond.document_key);

  const variants = [
    { name: 'attachment object', body: { attachment_id: { tenant: 'alpha' }, file_sha256: '' } },
    { name: 'attachment object without other document fields', body: { attachment_id: { tenant: 'alpha' }, file_sha256: '', filename: '', mime_type: '', ocr_text: '' } },
    { name: 'attachment array', body: { attachment_id: ['alpha'], file_sha256: '' } },
    { name: 'attachment number', body: { attachment_id: 42, file_sha256: '' } },
    { name: 'attachment too long', body: { attachment_id: 'a'.repeat(181), file_sha256: '' } },
    { name: 'attachment alias object', body: { attachmentId: { tenant: 'alias' } } },
    { name: 'filename object', body: { filename: { name: 'contract.pdf' } } },
    { name: 'filename too long', body: { filename: 'f'.repeat(181) } },
    { name: 'filename alias array', body: { file_name: ['contract.pdf'] } },
    { name: 'mime object', body: { mime_type: { type: 'application/pdf' } } },
    { name: 'mime too long', body: { mime_type: 'm'.repeat(121) } },
    { name: 'mime alias boolean', body: { mimeType: true } },
    { name: 'ocr object', body: { ocr_text: { text: longOcrText } } },
    { name: 'ocr alias number', body: { text: 42 } },
    { name: 'file hash array', body: { file_sha256: ['a'.repeat(64)] } },
    { name: 'file hash alias object', body: { sha256: { hash: 'a'.repeat(64) } } },
  ];
  for (const variant of variants) {
    const normalized = normalizeOnboarding(onboardingBody({
      deal_id: `strict-${variant.name}`,
      ...variant.body,
    }));
    const documentStep = plannedStep(normalized, 'signed_document');
    const offerStep = plannedStep(normalized, 'offer_out');
    assert.equal(documentStep.state, 'PRECONDITION_FAILED', variant.name);
    assert.equal(documentStep.predicted_child_key, '', variant.name);
    assert.ok(offerStep.predicted_child_key, variant.name);

    const direct = normalizeDocument({ ...directBase, ...variant.body });
    assert.equal(direct.invalid_input, true, variant.name);
    assert.equal(direct.status, 'Dead Letter', variant.name);
    assert.equal(direct.last_error_class, 'permanent', variant.name);
  }

  const valid = normalizeDocument(directBase);
  const validReplay = normalizeDocument(directBase);
  assert.equal(valid.invalid_input, false);
  assert.equal(valid.document_key, validReplay.document_key);
});

test('OCR quality metrics require supplied canonical and alias values to be finite numbers in range', () => {
  const baselineBody = onboardingBody({ deal_id: 'ocr-quality-contract-owner' });
  const baseline = normalizeOnboarding(baselineBody);
  const owner = baseline.onboarding_id;
  const directBase = {
    onboarding_id: owner,
    filename: 'ocr-quality-contract.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'ocr-quality-contract-attachment',
    file_sha256: '',
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const legitimate = normalizeDocument(directBase);
  const metrics = [
    {
      canonical: 'ocr_confidence',
      alias: 'ocrConfidence',
      other: 'scan_text_ratio',
      expectedOther: 0.95,
    },
    {
      canonical: 'scan_text_ratio',
      alias: 'scanTextRatio',
      other: 'ocr_confidence',
      expectedOther: 0.99,
    },
  ];
  const malformedValues = [
    ['numeric string', '0.8'],
    ['Infinity string', 'Infinity'],
    ['boolean', true],
    ['array', [0.8]],
    ['object', { value: 0.8 }],
    ['null', null],
    ['NaN', NaN],
    ['positive Infinity', Infinity],
    ['negative Infinity', -Infinity],
    ['below zero', -0.01],
    ['above one', 1.01],
  ];

  for (const metric of metrics) {
    for (const inputName of [metric.canonical, metric.alias]) {
      for (const [variantName, value] of malformedValues) {
        const label = `${inputName} ${variantName}`;
        const normalized = normalizeOnboarding({ ...baselineBody, [inputName]: value });
        const documentStep = plannedStep(normalized, 'signed_document');
        const request = JSON.parse(documentStep.request_snapshot_bytes);

        assert.equal(normalized.ok, true, label);
        assert.equal(documentStep.state, 'PRECONDITION_FAILED', label);
        assert.equal(documentStep.predicted_child_key, '', label);
        assert.match(documentStep.blocked_reason, new RegExp(metric.canonical), label);
        assert.equal(request[metric.canonical], 0, label);
        assert.equal(request[metric.other], metric.expectedOther, label);
        for (const stepName of ['offer_out', 'first_invoice', 'kickoff_booking', 'welcome_email', 'internal_checklist']) {
          assert.equal(
            plannedStep(normalized, stepName).predicted_child_key,
            plannedStep(baseline, stepName).predicted_child_key,
            `${label}:${stepName}`,
          );
        }

        const direct = normalizeDocument({ ...directBase, [inputName]: value });
        assert.equal(direct.invalid_input, true, label);
        assert.equal(direct.ocr_usable, false, label);
        assert.equal(direct.status, 'Dead Letter', label);
        assert.equal(direct.last_error_class, 'permanent', label);
        assert.match(direct.validation_errors, new RegExp(metric.canonical), label);
        assert.equal(direct[metric.canonical], 0, label);
        assert.equal(direct[metric.other], metric.expectedOther, label);
        assert.equal(JSON.parse(direct.raw_event_json)[metric.canonical], 0, label);
        assert.notEqual(direct.document_key, legitimate.document_key, label);
      }
    }
  }

  for (const fixture of [
    { name: 'invalid canonical confidence with valid alias', values: { ocr_confidence: [0.8], ocrConfidence: 0.99 }, field: 'ocr_confidence' },
    { name: 'invalid canonical ratio with valid alias', values: { scan_text_ratio: null, scanTextRatio: 0.95 }, field: 'scan_text_ratio' },
  ]) {
    const normalized = normalizeOnboarding({ ...baselineBody, ...fixture.values });
    const step = plannedStep(normalized, 'signed_document');
    const direct = normalizeDocument({ ...directBase, ...fixture.values });
    assert.equal(step.state, 'PRECONDITION_FAILED', fixture.name);
    assert.equal(step.predicted_child_key, '', fixture.name);
    assert.match(step.blocked_reason, new RegExp(fixture.field), fixture.name);
    assert.equal(direct.status, 'Dead Letter', fixture.name);
    assert.equal(direct.ocr_usable, false, fixture.name);
    assert.equal(direct[fixture.field], 0, fixture.name);
  }
});

test('malformed OCR quality claims are collision-isolated and dead-letter before any model descendant', () => {
  const normalized = normalizeOnboarding(onboardingBody({
    deal_id: 'ocr-quality-claim-owner',
    ocr_confidence: true,
    scan_text_ratio: [0.8],
  }));
  const onboardingStep = plannedStep(normalized, 'signed_document');
  assert.equal(onboardingStep.state, 'PRECONDITION_FAILED');
  assert.equal(onboardingStep.predicted_child_key, '');
  assert.match(onboardingStep.blocked_reason, /ocr_confidence/);
  assert.match(onboardingStep.blocked_reason, /scan_text_ratio/);

  const directBase = {
    onboarding_id: normalized.onboarding_id,
    filename: 'same-quality-document.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'same-quality-attachment',
    file_sha256: '',
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const attacker = normalizeDocument({
    ...directBase,
    ocr_confidence: true,
    scan_text_ratio: [0.8],
  });
  const legitimate = normalizeDocument(directBase);
  const claims = {};
  const attackerClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: attacker,
    workflowStaticData: claims,
  }).json;
  const legitimateClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: legitimate,
    workflowStaticData: claims,
  }).json;

  assert.equal(attacker.invalid_input, true);
  assert.equal(attacker.ocr_usable, false);
  assert.equal(attacker.status, 'Dead Letter');
  assert.equal(attacker.last_error_class, 'permanent');
  assert.equal(attacker.ocr_confidence, 0);
  assert.equal(attacker.scan_text_ratio, 0);
  assert.notEqual(attacker.document_key, legitimate.document_key);
  assert.equal(attackerClaim.duplicate_claim, false);
  assert.equal(legitimateClaim.duplicate_claim, false);

  const workflow = loadWorkflow(documentWorkflow);
  const next = (name, branch) => (workflow.connections[name]?.main?.[branch] || []).map((edge) => edge.node);
  const descendants = (start) => {
    const seen = new Set();
    const pending = [start];
    while (pending.length) {
      const name = pending.pop();
      for (const branches of workflow.connections[name]?.main || []) {
        for (const edge of branches) {
          if (seen.has(edge.node)) continue;
          seen.add(edge.node);
          pending.push(edge.node);
        }
      }
    }
    return seen;
  };
  assert.deepEqual(next('Document Intake Dead Letter?', 0), ['Insert Document Dead Letter']);
  assert.equal(descendants('Insert Document Dead Letter').has('Extract Document Fields'), false);
});

test('permanent invalid document claims cannot evict an active valid claim', () => {
  const validRequest = {
    filename: 'claim-cache-valid.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'claim-cache-valid-attachment',
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const valid = normalizeDocument(validRequest);
  const workflowStaticData = {};
  const firstValidClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: valid,
    workflowStaticData,
  }).json;
  assert.equal(valid.status, 'AI Pending');
  assert.equal(firstValidClaim.duplicate_claim, false);

  const invalidKeys = new Set();
  for (let index = 0; index < 5_001; index += 1) {
    const invalid = normalizeDocument({
      ...validRequest,
      attachment_id: `claim-cache-invalid-${index}`,
      ocr_confidence: `invalid-${index}`,
    });
    const claim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
      input: invalid,
      workflowStaticData,
    }).json;
    assert.equal(invalid.status, 'Dead Letter', String(index));
    assert.equal(invalid.last_error_class, 'permanent', String(index));
    assert.equal(claim.duplicate_claim, false, String(index));
    invalidKeys.add(invalid.document_key);
  }

  assert.equal(invalidKeys.size, 5_001);
  const validReplay = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: valid,
    workflowStaticData,
  }).json;
  assert.equal(validReplay.duplicate_claim, true);
  assert.equal(validReplay.duplicate_status, 'in_progress');
  assert.deepEqual(Object.keys(workflowStaticData.document_claims), [documentClaimKey(valid)]);
});

test('a permanent invalid claim bypasses claim-store initialization', () => {
  const invalid = normalizeDocument({
    filename: 'claim-cache-isolated-invalid.pdf',
    mime_type: 'application/pdf',
    attachment_id: 'claim-cache-isolated-invalid',
    ocr_text: longOcrText,
    ocr_confidence: 'invalid-isolated',
    scan_text_ratio: 0.95,
  });
  const workflowStaticData = {};
  const claim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: invalid,
    workflowStaticData,
  }).json;

  assert.equal(invalid.status, 'Dead Letter');
  assert.equal(invalid.last_error_class, 'permanent');
  assert.equal(claim.duplicate_claim, false);
  assert.equal(Object.hasOwn(workflowStaticData, 'document_claims'), false);
});

test('permanent dead-letter claim and finalization never touch the valid claim cache', () => {
  const sharedFileSha256 = 'd'.repeat(64);
  const validRequest = {
    filename: 'dead-letter-cache-valid.pdf',
    mime_type: 'application/pdf',
    file_sha256: sharedFileSha256,
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const valid = executeCodeNode(documentWorkflow, 'Normalize Document Intake', {
    input: { body: validRequest },
    executionId: 'good',
  }).json;
  const workflowStaticData = {};
  const validClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: valid,
    workflowStaticData,
  }).json;
  const validClaimBytes = JSON.stringify(workflowStaticData.document_claims[documentClaimKey(valid)]);
  assert.equal(valid.last_execution_id, 'good');
  assert.equal(validClaim.duplicate_claim, false);

  let cacheBytesAfterOne = '';
  let invalidDocumentKey = '';
  let validReplayAfterOne;
  for (let index = 0; index < 5_001; index += 1) {
    const invalid = executeCodeNode(documentWorkflow, 'Normalize Document Intake', {
      input: {
        body: {
          ...validRequest,
          mime_type: 'application/unsupported',
        },
      },
      executionId: `bad-${index}`,
    }).json;
    const invalidClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
      input: invalid,
      workflowStaticData,
    }).json;
    const record = {
      id: `dead-letter-row-${index}`,
      status: 'Dead Letter',
      marker: `inserted-record-${index}`,
    };
    const finalized = executeCodeNode(documentWorkflow, 'Mark Document Claim Dead Letter', {
      input: record,
      nodeOutputs: { 'Normalize Document Intake': invalid },
      workflowStaticData,
    }).json;
    assert.equal(invalid.last_execution_id, `bad-${index}`, String(index));
    assert.equal(invalid.status, 'Dead Letter', String(index));
    assert.equal(invalid.last_error_class, 'permanent', String(index));
    assert.notEqual(invalid.document_key, valid.document_key, String(index));
    if (index === 0) invalidDocumentKey = invalid.document_key;
    else assert.equal(invalid.document_key, invalidDocumentKey, String(index));
    assert.equal(invalidClaim.duplicate_claim, false, String(index));
    assert.deepEqual(finalized, record, String(index));
    if (index === 0) {
      cacheBytesAfterOne = JSON.stringify(workflowStaticData.document_claims?.[documentClaimKey(valid)]);
      validReplayAfterOne = executeCodeNode(documentWorkflow, 'Claim Document Key', {
        input: valid,
        workflowStaticData,
      }).json;
    }
  }

  assert.equal(cacheBytesAfterOne, validClaimBytes);
  assert.equal(validReplayAfterOne.duplicate_claim, true);
  assert.equal(validReplayAfterOne.duplicate_status, 'in_progress');
  assert.equal(Object.keys(workflowStaticData.document_claims).length, 1);
  assert.deepEqual(Object.keys(workflowStaticData.document_claims), [documentClaimKey(valid)]);
  assert.equal(JSON.stringify(workflowStaticData.document_claims[documentClaimKey(valid)]), validClaimBytes);
  const validReplay = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: valid,
    workflowStaticData,
  }).json;
  assert.equal(validReplay.duplicate_claim, true);
  assert.equal(validReplay.duplicate_status, 'in_progress');

  const workflow = loadWorkflow(documentWorkflow);
  const code = (name) => workflow.nodes.find((node) => node.name === name).parameters.jsCode;
  const claimCode = code('Claim Document Key');
  const markCode = code('Mark Document Claim Dead Letter');
  assert.ok(claimCode.indexOf('if (permanentDeadLetter)') < claimCode.indexOf("$getWorkflowStaticData('global')"));
  assert.ok(markCode.indexOf('if (permanentDeadLetter)') < markCode.indexOf("$getWorkflowStaticData('global')"));
  const next = (name, branch = 0) => (
    workflow.connections[name]?.main?.[branch] || []
  ).map((edge) => edge.node);
  assert.deepEqual(next('Claim Document Key'), ['Document Claim Duplicate?']);
  assert.deepEqual(next('Document Claim Duplicate?', 1), ['Find Existing Document Row']);
  assert.deepEqual(next('Find Existing Document Row'), ['Persistent Document Duplicate?']);
  assert.deepEqual(next('Persistent Document Duplicate?', 1), ['Document Intake Dead Letter?']);
  assert.deepEqual(next('Document Intake Dead Letter?'), ['Insert Document Dead Letter']);
  assert.deepEqual(next('Insert Document Dead Letter'), ['Mark Document Claim Dead Letter']);
  assert.deepEqual(next('Mark Document Claim Dead Letter'), ['Respond Document Dead Letter']);
});

test('an isolated permanent dead-letter finalizer bypasses claim-store initialization', () => {
  const invalid = executeCodeNode(documentWorkflow, 'Normalize Document Intake', {
    input: {
      body: {
        filename: 'isolated-dead-letter.pdf',
        mime_type: 'application/unsupported',
        file_sha256: 'e'.repeat(64),
        ocr_text: longOcrText,
        ocr_confidence: 0.99,
        scan_text_ratio: 0.95,
      },
    },
    executionId: 'isolated-invalid',
  }).json;
  const workflowStaticData = {};
  const record = { id: 'isolated-dead-letter-row', status: 'Dead Letter' };
  const finalized = executeCodeNode(documentWorkflow, 'Mark Document Claim Dead Letter', {
    input: record,
    nodeOutputs: { 'Normalize Document Intake': invalid },
    workflowStaticData,
  }).json;

  assert.deepEqual(finalized, record);
  assert.equal(Object.hasOwn(workflowStaticData, 'document_claims'), false);
});

test('OCR quality boundaries and missing fields keep valid key parity and low-quality review behavior', () => {
  const ownerBody = onboardingBody({ deal_id: 'ocr-quality-boundary-owner' });
  delete ownerBody.ocr_confidence;
  delete ownerBody.scan_text_ratio;
  const fixtures = [
    { name: 'canonical zero boundary', values: { ocr_confidence: 0, scan_text_ratio: 0 }, usable: false },
    { name: 'canonical one boundary', values: { ocr_confidence: 1, scan_text_ratio: 1 }, usable: true },
    { name: 'alias zero boundary', values: { ocrConfidence: 0, scanTextRatio: 0 }, usable: false },
    { name: 'alias one boundary', values: { ocrConfidence: 1, scanTextRatio: 1 }, usable: true },
    { name: 'missing metrics', values: {}, usable: false },
  ];

  for (const fixture of fixtures) {
    const normalized = normalizeOnboarding({ ...ownerBody, ...fixture.values });
    const step = plannedStep(normalized, 'signed_document');
    const request = JSON.parse(step.request_snapshot_bytes);
    const child = normalizeDocument(request);
    const expected = fixture.name.includes('one') ? 1 : 0;
    assert.equal(step.state, 'INTENT_WRITTEN', fixture.name);
    assert.ok(step.predicted_child_key, fixture.name);
    assert.equal(request.ocr_confidence, expected, fixture.name);
    assert.equal(request.scan_text_ratio, expected, fixture.name);
    assert.equal(child.ocr_confidence, expected, fixture.name);
    assert.equal(child.scan_text_ratio, expected, fixture.name);
    assert.equal(child.ocr_usable, fixture.usable, fixture.name);
    assert.equal(child.validation_errors, '', fixture.name);
    assert.equal(child.status, fixture.usable ? 'AI Pending' : 'Needs Review', fixture.name);
    assert.equal(child.last_error_class, fixture.usable ? '' : 'business', fixture.name);
    assert.equal(child.document_key, step.predicted_child_key, fixture.name);
  }

  const noDocument = { ...ownerBody };
  noDocument.filename = '';
  noDocument.mime_type = '';
  noDocument.attachment_id = '';
  noDocument.file_sha256 = '';
  noDocument.ocr_text = '';
  const missingDocument = plannedStep(normalizeOnboarding(noDocument), 'signed_document');
  assert.equal(missingDocument.state, 'DOC_WAITING_UPLOAD');
  assert.equal(missingDocument.predicted_child_key, '');
  const missingRequest = JSON.parse(missingDocument.request_snapshot_bytes);
  assert.equal(missingRequest.ocr_confidence, 0);
  assert.equal(missingRequest.scan_text_ratio, 0);
});

test('document normalizer preserves standalone keys and scopes valid parent-owned keys', () => {
  const fileSha256 = 'b'.repeat(64);
  const request = {
    filename: 'same-document.pdf',
    mime_type: 'application/pdf',
    file_sha256: fileSha256,
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const legacyKey = crypto.createHash('sha256').update(`doc-intake\n${fileSha256}`).digest('hex');
  const standalone = normalizeDocument(request);
  assert.equal(standalone.invalid_input, false);
  assert.equal(standalone.onboarding_id, '');
  assert.equal(standalone.document_key, legacyKey);

  const uppercaseOwner = 'ABCDEF'.repeat(10) + 'ABCD';
  const owned = normalizeDocument({ ...request, onboarding_id: uppercaseOwner });
  const normalizedOwner = uppercaseOwner.toLowerCase();
  const ownedKey = crypto.createHash('sha256')
    .update(`doc-intake\n${normalizedOwner}\n${fileSha256}`)
    .digest('hex');
  assert.equal(owned.invalid_input, false);
  assert.equal(owned.onboarding_id, normalizedOwner);
  assert.equal(owned.document_key, ownedKey);
  assert.notEqual(owned.document_key, legacyKey);

  for (const onboarding_id of ['', null, 'not-a-valid-owner', 'g'.repeat(64), 'a'.repeat(63)]) {
    const invalid = normalizeDocument({ ...request, onboarding_id });
    assert.equal(invalid.invalid_input, true, JSON.stringify(onboarding_id));
    assert.match(invalid.validation_errors, /onboarding_id/i, JSON.stringify(onboarding_id));
  }
});

test('invalid document owners cannot poison the standalone claim or reach the model path', () => {
  const request = {
    filename: 'same-document.pdf',
    mime_type: 'application/pdf',
    file_sha256: 'e'.repeat(64),
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const standalone = normalizeDocument(request);
  const malformed = normalizeDocument({ ...request, onboarding_id: 'not-a-valid-owner' });
  const claims = {};
  const malformedClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: malformed,
    workflowStaticData: claims,
  }).json;
  const standaloneClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: standalone,
    workflowStaticData: claims,
  }).json;
  assert.equal(malformed.ocr_usable, true);
  assert.equal(malformedClaim.duplicate_claim, false);
  assert.equal(standaloneClaim.duplicate_claim, false);
  assert.notEqual(malformed.document_key, standalone.document_key);

  const validOwner = 'F'.repeat(64);
  const valid = normalizeDocument({ ...request, onboarding_id: validOwner });
  for (const onboarding_id of [
    '',
    null,
    [],
    [validOwner],
    { owner: validOwner },
    'not-a-valid-owner',
    'x'.repeat(20_000),
  ]) {
    const invalid = normalizeDocument({ ...request, onboarding_id });
    const replay = normalizeDocument({ ...request, onboarding_id });
    assert.equal(invalid.invalid_input, true, JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.equal(invalid.onboarding_id, '', JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.equal(invalid.status, 'Dead Letter', JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.equal(invalid.last_error_class, 'permanent', JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.match(invalid.validation_errors, /onboarding_id/i, JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.equal(invalid.last_error_message, invalid.validation_errors, JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.equal(JSON.parse(invalid.raw_event_json).onboarding_id, '', JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.equal(invalid.document_key, replay.document_key, JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.notEqual(invalid.document_key, standalone.document_key, JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.notEqual(invalid.document_key, valid.document_key, JSON.stringify(onboarding_id)?.slice(0, 100));
    assert.match(invalid.document_key, /^[a-f0-9]{64}$/);
  }
  assert.equal(valid.invalid_input, false);
  assert.equal(valid.onboarding_id, validOwner.toLowerCase());

  const workflow = loadWorkflow(documentWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  const next = (name, branch) => (workflow.connections[name]?.main?.[branch] || []).map((edge) => edge.node);
  const deadLetterIf = nodesByName.get('Document Intake Dead Letter?');
  assert.equal(deadLetterIf.parameters.conditions.conditions[0].rightValue, 'Dead Letter');
  assert.deepEqual(next('Persistent Document Duplicate?', 1), ['Document Intake Dead Letter?']);
  assert.deepEqual(next('Document Intake Dead Letter?', 0), ['Insert Document Dead Letter']);
  assert.deepEqual(next('Document Intake Dead Letter?', 1), ['OCR Usable?']);
  assert.deepEqual(next('OCR Usable?', 0), ['Extract Document Fields']);
});

test('document owner identity must be an exact raw 64-hex string before claim', () => {
  const request = {
    filename: 'exact-owner-document.pdf',
    mime_type: 'application/pdf',
    file_sha256: '7'.repeat(64),
    ocr_text: longOcrText,
    ocr_confidence: 0.99,
    scan_text_ratio: 0.95,
  };
  const uppercaseOwner = 'ABCDEF'.repeat(10) + 'ABCD';
  const paddedOwner = `  ${uppercaseOwner}\n`;
  const exact = normalizeDocument({ ...request, onboarding_id: uppercaseOwner });
  const standalone = normalizeDocument(request);
  const padded = normalizeDocument({ ...request, onboarding_id: paddedOwner });
  const invalidOwnerFingerprint = crypto.createHash('sha256')
    .update(`invalid-owner.v1\nstring\n${paddedOwner}`)
    .digest('hex');
  const expectedPaddedKey = crypto.createHash('sha256')
    .update(`doc-intake\nINVALID-OWNER\n${invalidOwnerFingerprint}\n${request.file_sha256}`)
    .digest('hex');
  const claims = {};

  const paddedClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: padded,
    workflowStaticData: claims,
  }).json;
  const exactClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: exact,
    workflowStaticData: claims,
  }).json;
  const standaloneClaim = executeCodeNode(documentWorkflow, 'Claim Document Key', {
    input: standalone,
    workflowStaticData: claims,
  }).json;

  assert.equal(paddedClaim.duplicate_claim, false);
  assert.equal(exactClaim.duplicate_claim, false);
  assert.equal(standaloneClaim.duplicate_claim, false);
  assert.equal(exact.invalid_input, false);
  assert.equal(exact.onboarding_id, uppercaseOwner.toLowerCase());
  assert.equal(padded.invalid_input, true);
  assert.equal(padded.onboarding_id, '');
  assert.equal(padded.status, 'Dead Letter');
  assert.equal(padded.last_error_class, 'permanent');
  assert.match(padded.validation_errors, /onboarding_id/i);
  assert.equal(padded.document_key, expectedPaddedKey);
  assert.notEqual(padded.document_key, exact.document_key);
  assert.notEqual(padded.document_key, standalone.document_key);
  assert.equal(
    padded.document_key,
    normalizeDocument({ ...request, onboarding_id: paddedOwner }).document_key,
  );

  for (const onboarding_id of [
    `${uppercaseOwner} `,
    `\t${uppercaseOwner}`,
    `${uppercaseOwner}\n`,
    `${uppercaseOwner.slice(0, 32)}\t${uppercaseOwner.slice(32)}`,
  ]) {
    const invalid = normalizeDocument({ ...request, onboarding_id });
    assert.equal(invalid.invalid_input, true, JSON.stringify(onboarding_id));
    assert.equal(invalid.status, 'Dead Letter', JSON.stringify(onboarding_id));
    assert.equal(invalid.last_error_class, 'permanent', JSON.stringify(onboarding_id));
    assert.match(invalid.document_key, /^[a-f0-9]{64}$/);
    assert.equal(
      invalid.document_key,
      normalizeDocument({ ...request, onboarding_id }).document_key,
      JSON.stringify(onboarding_id),
    );
    assert.notEqual(invalid.document_key, exact.document_key, JSON.stringify(onboarding_id));
    assert.notEqual(invalid.document_key, standalone.document_key, JSON.stringify(onboarding_id));
  }

  const workflow = loadWorkflow(documentWorkflow);
  const next = (name, branch) => (workflow.connections[name]?.main?.[branch] || []).map((edge) => edge.node);
  assert.deepEqual(next('Document Intake Dead Letter?', 0), ['Insert Document Dead Letter']);
  assert.deepEqual(next('Document Intake Dead Letter?', 1), ['OCR Usable?']);
  assert.deepEqual(next('OCR Usable?', 0), ['Extract Document Fields']);
});

test('every terminal document insert persists onboarding ownership in its mapping and schema', () => {
  const workflow = loadWorkflow(documentWorkflow);
  const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
  for (const name of [
    'Insert Document Dead Letter',
    'Insert Filed Document Record',
    'Insert AI Needs Review',
    'Insert OCR Needs Review',
  ]) {
    const columns = nodesByName.get(name).parameters.columns;
    assert.match(columns.value.onboarding_id, /onboarding_id/, name);
    assert.ok(columns.schema.some((column) => column.id === 'onboarding_id'), name);
  }
});

test('document AI output schema rejects malformed confidence, amount, review, and currency values', () => {
  const malformedResult = (name, ai) => {
    const result = validateDocumentAI(ai);
    assert.equal(result.auto_file, false, name);
    assert.equal(result.status, 'Needs Review', name);
    assert.ok(result.validation_errors, name);
    assert.ok(result.review_reason, name);
    assert.match(result.archive_path, /^review\//, name);
    assert.deepEqual(documentAIDecisionRoute(result), ['Insert AI Needs Review'], name);
    assert.equal(documentAIDecisionRoute(result).includes('Insert Filed Document Record'), false, name);
    return result;
  };
  const malformedUnitIntervalValues = [
    ['string', '0.99'],
    ['boolean', true],
    ['array', [0.99]],
    ['object', { value: 0.99 }],
    ['null', null],
    ['above one', 2],
    ['below zero', -0.1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['negative Infinity', -Infinity],
  ];

  for (const [name, value] of malformedUnitIntervalValues) {
    const result = malformedResult(`confidence ${name}`, validDocumentAI({ confidence: value }));
    assert.equal(result.confidence, 0, name);
  }
  const missingConfidence = validDocumentAI();
  delete missingConfidence.confidence;
  assert.equal(malformedResult('confidence missing', missingConfidence).confidence, 0);

  for (const field of ['document_type', 'party_name', 'document_date', 'amount_total']) {
    for (const [name, value] of malformedUnitIntervalValues) {
      const result = malformedResult(`field_confidence.${field} ${name}`, validDocumentAI({
        field_confidence: { ...validDocumentAI().field_confidence, [field]: value },
      }));
      assert.equal(result.field_confidence[field], 0, `${field} ${name}`);
    }
    const fieldConfidence = { ...validDocumentAI().field_confidence };
    delete fieldConfidence[field];
    const result = malformedResult(`field_confidence.${field} missing`, validDocumentAI({ field_confidence: fieldConfidence }));
    assert.equal(result.field_confidence[field], 0, field);
  }

  for (const [name, field_confidence] of [
    ['array', []],
    ['null', null],
  ]) {
    const result = malformedResult(`field_confidence ${name}`, validDocumentAI({ field_confidence }));
    assert.deepEqual(result.field_confidence, {
      document_type: 0,
      party_name: 0,
      document_date: 0,
      amount_total: 0,
    }, name);
  }
  const missingFieldConfidence = validDocumentAI();
  delete missingFieldConfidence.field_confidence;
  assert.deepEqual(malformedResult('field_confidence missing', missingFieldConfidence).field_confidence, {
    document_type: 0,
    party_name: 0,
    document_date: 0,
    amount_total: 0,
  });

  for (const [name, amount_total] of [
    ['string', '100.00'],
    ['boolean', true],
    ['array', []],
    ['object', { value: 100 }],
    ['undefined', undefined],
    ['empty string', ''],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['below zero', -0.01],
    ['above maximum', 10_000_000.01],
  ]) {
    const result = malformedResult(`amount_total ${name}`, validDocumentAI({ amount_total }));
    assert.equal(result.amount_total, null, name);
  }

  for (const [name, needs_human_review] of [
    ['string', 'true'],
    ['zero', 0],
    ['one', 1],
    ['null', null],
  ]) {
    const result = malformedResult(`needs_human_review ${name}`, validDocumentAI({ needs_human_review }));
    assert.equal(result.needs_human_review, true, name);
  }
  const missingReviewDecision = validDocumentAI();
  delete missingReviewDecision.needs_human_review;
  assert.equal(malformedResult('needs_human_review missing', missingReviewDecision).needs_human_review, true);

  for (const [name, currency] of [
    ['boolean', false],
    ['object', { code: 'PLN' }],
    ['whitespace-padded string', ' PLN '],
  ]) {
    const result = malformedResult(`currency ${name}`, validDocumentAI({ currency }));
    assert.equal(result.currency, 'Unknown', name);
  }
  const missingCurrency = validDocumentAI();
  delete missingCurrency.currency;
  assert.equal(malformedResult('currency missing', missingCurrency).currency, 'Unknown');
});

test('document AI raw JSON rejects duplicate object keys before last-wins parsing', () => {
  const assertDuplicateRoutesToReview = (name, input) => {
    const result = validateDocumentAI(input);
    assert.equal(result.auto_file, false, name);
    assert.equal(result.status, 'Needs Review', name);
    assert.match(result.validation_errors, /duplicate JSON object key/i, name);
    assert.ok(result.review_reason, name);
    assert.deepEqual(documentAIDecisionRoute(result), ['Insert AI Needs Review'], name);
    assert.equal(documentAIDecisionRoute(result).includes('Insert Filed Document Record'), false, name);
    return result;
  };

  const duplicateTopLevelReviewDecision = '{"document_type":"Invoice","party_name":"Example Supplier Sp. z o.o.","document_date":"2026-01-15","amount_total":100,"currency":"PLN","confidence":0.99,"field_confidence":{"document_type":0.99,"party_name":0.99,"document_date":0.99,"amount_total":0.99},"needs_human_review":true,"needs_human_review":false,"review_reason":"","evidence":{}}';
  const conflictingDecision = assertDuplicateRoutesToReview('conflicting top-level needs_human_review', duplicateTopLevelReviewDecision);
  assert.equal(conflictingDecision.needs_human_review, false, 'duplicate rejection must override the parsed last value');

  const duplicateNestedConfidence = '{"document_type":"Invoice","party_name":"Example Supplier Sp. z o.o.","document_date":"2026-01-15","amount_total":100,"currency":"PLN","confidence":0.99,"field_confidence":{"document_type":0.99,"party_name":0.99,"document_date":0.99,"amount_total":0.99,"amount_total":0.99},"needs_human_review":false,"review_reason":"","evidence":{}}';
  assertDuplicateRoutesToReview('identical nested field_confidence key', { output: [{ content: [{ text: duplicateNestedConfidence }] }] });

  const escapedEquivalentReviewDecision = '{"document_type":"Invoice","party_name":"Example Supplier Sp. z o.o.","document_date":"2026-01-15","amount_total":100,"currency":"PLN","confidence":0.99,"field_confidence":{"document_type":0.99,"party_name":0.99,"document_date":0.99,"amount_total":0.99},"needs_human_re\\u0076iew":true,"needs_human_review":false,"review_reason":"","evidence":{}}';
  assertDuplicateRoutesToReview('escaped-equivalent top-level key', { text: `\`\`\`json\n${escapedEquivalentReviewDecision}\n\`\`\`` });
});

test('document AI duplicate-key scan preserves valid nested and punctuation-heavy JSON', () => {
  const valid = validDocumentAI({
    party_name: 'Example "Supplier" {PLN}',
    evidence: {
      first: { snippet: 'Text says {"needs_human_review": true}, then closes }.' },
      second: { snippet: 'Escaped quote: "ok"; brackets: [one, two].' },
    },
  });

  const direct = validateDocumentAI(JSON.stringify(valid));
  assert.equal(direct.auto_file, true);
  assert.equal(direct.status, 'Filed');
  assert.deepEqual(documentAIDecisionRoute(direct), ['Insert Filed Document Record']);

  const nestedFenced = validateDocumentAI({
    output: [{ content: [{ text: `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`` }] }],
  });
  assert.equal(nestedFenced.auto_file, true);
  assert.equal(nestedFenced.status, 'Filed');
  assert.deepEqual(documentAIDecisionRoute(nestedFenced), ['Insert Filed Document Record']);

  const malformed = validateDocumentAI('{"document_type":"Invoice","field_confidence":{"amount_total":0.99,}');
  assert.equal(malformed.auto_file, false);
  assert.equal(malformed.status, 'Needs Review');
  assert.ok(malformed.validation_errors);
  assert.ok(malformed.review_reason);
  assert.deepEqual(documentAIDecisionRoute(malformed), ['Insert AI Needs Review']);

  const oversized = validateDocumentAI(`{"payload":"${'a'.repeat(200_001)}"}`);
  assert.equal(oversized.auto_file, false);
  assert.equal(oversized.status, 'Needs Review');
  assert.match(oversized.validation_errors, /structural scan limit/i);
  assert.deepEqual(documentAIDecisionRoute(oversized), ['Insert AI Needs Review']);
});

test('document AI structural scan is bounded consistently across raw text envelopes', () => {
  const oldPolicyPayload = validDocumentAIJsonWithTrailingWhitespace(100_000);
  const oldPolicyResult = validateDocumentAI(oldPolicyPayload);
  assert.equal(oldPolicyResult.auto_file, false);
  assert.equal(oldPolicyResult.status, 'Needs Review');
  assert.match(oldPolicyResult.validation_errors, /structural scan failed.*exceeds 12000-character structural scan limit/i);
  assert.deepEqual(documentAIDecisionRoute(oldPolicyResult), ['Insert AI Needs Review']);

  const envelopes = [
    [
      'direct',
      validDocumentAIJsonWithTrailingWhitespace(documentAIStructuralScanLimit),
      validDocumentAIJsonWithTrailingWhitespace(documentAIStructuralScanLimit + 1),
    ],
    [
      'fenced',
      validDocumentAIFencedTextAtLength(documentAIStructuralScanLimit),
      validDocumentAIFencedTextAtLength(documentAIStructuralScanLimit + 1),
    ],
    [
      'nested extracted text',
      { output: [{ content: [{ text: validDocumentAIJsonWithTrailingWhitespace(documentAIStructuralScanLimit) }] }] },
      { output: [{ content: [{ text: validDocumentAIJsonWithTrailingWhitespace(documentAIStructuralScanLimit + 1) }] }] },
    ],
  ];

  for (const [name, atLimit, overLimit] of envelopes) {
    const filed = validateDocumentAI(atLimit);
    assert.equal(filed.auto_file, true, `${name} at limit`);
    assert.equal(filed.status, 'Filed', `${name} at limit`);
    assert.deepEqual(documentAIDecisionRoute(filed), ['Insert Filed Document Record'], `${name} at limit`);

    const held = validateDocumentAI(overLimit);
    assert.equal(held.auto_file, false, `${name} over limit`);
    assert.equal(held.status, 'Needs Review', `${name} over limit`);
    assert.match(held.validation_errors, /structural scan failed.*exceeds 12000-character structural scan limit/i, `${name} over limit`);
    assert.deepEqual(documentAIDecisionRoute(held), ['Insert AI Needs Review'], `${name} over limit`);
  }
});

test('document AI output accepts only typed schema boundaries and respects review decisions', () => {
  const validOneBoundary = validDocumentAI({
    amount_total: 0,
    confidence: 1,
    field_confidence: {
      document_type: 1,
      party_name: 1,
      document_date: 1,
      amount_total: 1,
    },
  });
  const filed = validateDocumentAI({ output: `\`\`\`json\n${JSON.stringify(validOneBoundary)}\n\`\`\`` });
  assert.equal(filed.auto_file, true);
  assert.equal(filed.status, 'Filed');
  assert.equal(filed.amount_total, 0);
  assert.equal(filed.confidence, 1);
  assert.deepEqual(filed.field_confidence, validOneBoundary.field_confidence);
  assert.deepEqual(documentAIDecisionRoute(filed), ['Insert Filed Document Record']);

  const maximumAmount = validateDocumentAI(validDocumentAI({ amount_total: 10_000_000 }));
  assert.equal(maximumAmount.auto_file, true);
  assert.equal(maximumAmount.amount_total, 10_000_000);

  const zeroBoundary = validateDocumentAI(validDocumentAI({
    confidence: 0,
    field_confidence: {
      document_type: 0,
      party_name: 0,
      document_date: 0,
      amount_total: 0,
    },
  }));
  assert.equal(zeroBoundary.auto_file, false);
  assert.equal(zeroBoundary.status, 'Needs Review');
  assert.equal(zeroBoundary.confidence, 0);
  assert.deepEqual(zeroBoundary.field_confidence, {
    document_type: 0,
    party_name: 0,
    document_date: 0,
    amount_total: 0,
  });
  assert.doesNotMatch(zeroBoundary.validation_errors, /must be a finite number/);
  assert.deepEqual(documentAIDecisionRoute(zeroBoundary), ['Insert AI Needs Review']);

  const requestedReview = validateDocumentAI(validDocumentAI({ needs_human_review: true }));
  assert.equal(requestedReview.auto_file, false);
  assert.equal(requestedReview.status, 'Needs Review');
  assert.match(requestedReview.review_reason, /requested human review/i);
  assert.deepEqual(documentAIDecisionRoute(requestedReview), ['Insert AI Needs Review']);

  const contractWithoutAmount = validateDocumentAI(validDocumentAI({
    document_type: 'Contract',
    amount_total: null,
    currency: 'Unknown',
  }));
  assert.equal(contractWithoutAmount.auto_file, true);
  assert.equal(contractWithoutAmount.status, 'Filed');
  assert.equal(contractWithoutAmount.amount_total, null);
  assert.deepEqual(documentAIDecisionRoute(contractWithoutAmount), ['Insert Filed Document Record']);
});

test('deal and client external identities use disjoint onboarding namespaces', () => {
  const sharedIdentity = 'shared-business-identity-001';
  const dealBody = onboardingBody({ deal_id: sharedIdentity, client_external_id: '' });
  const externalBody = onboardingBody({ deal_id: '', client_external_id: sharedIdentity });
  const deal = normalizeOnboarding(dealBody);
  const external = normalizeOnboarding(externalBody);
  const dealReplay = normalizeOnboarding(dealBody);
  const externalReplay = normalizeOnboarding(externalBody);

  const firstClaim = executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
    inputRows: [],
    nodeOutputs: { 'Normalize Onboarding': deal },
  }).json;
  const secondClaim = executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
    inputRows: [{
      onboarding_id: deal.onboarding_id,
      smoke_tag: deal.smoke_tag,
      state: 'CLAIMED',
    }],
    nodeOutputs: { 'Normalize Onboarding': external },
  }).json;

  assert.equal(firstClaim.should_insert_claim, true);
  assert.equal(secondClaim.should_insert_claim, true);
  assert.equal(secondClaim.existing_onboarding_count, 0);
  assert.equal(deal.identity_source, 'deal_id');
  assert.equal(external.identity_source, 'client_external_id');
  assert.equal(
    deal.onboarding_id,
    crypto.createHash('sha256').update(`onboarding.v1\n${sharedIdentity}`).digest('hex'),
  );
  assert.equal(
    external.onboarding_id,
    crypto.createHash('sha256').update(`onboarding.client_external_id.v1\n${sharedIdentity}`).digest('hex'),
  );
  assert.notEqual(deal.onboarding_id, external.onboarding_id);
  assert.equal(dealReplay.onboarding_id, deal.onboarding_id);
  assert.equal(externalReplay.onboarding_id, external.onboarding_id);

  for (const stepName of ['offer_out', 'first_invoice', 'kickoff_booking', 'signed_document']) {
    const dealStep = plannedStep(deal, stepName);
    const externalStep = plannedStep(external, stepName);
    assert.ok(dealStep.predicted_child_key, stepName);
    assert.ok(externalStep.predicted_child_key, stepName);
    assert.notEqual(dealStep.predicted_child_key, externalStep.predicted_child_key, stepName);
    assert.equal(dealStep.predicted_child_key, plannedStep(dealReplay, stepName).predicted_child_key, stepName);
    assert.equal(externalStep.predicted_child_key, plannedStep(externalReplay, stepName).predicted_child_key, stepName);
  }
});

test('onboarding stable identities require bounded strings before claims', () => {
  const invalidBodies = [
    { deal_id: { tenant: 'alpha' } },
    { deal_id: { tenant: 'beta' } },
    { deal_id: { tenant: 'missing-document' }, filename: '', mime_type: '', attachment_id: '', file_sha256: '', ocr_text: '' },
    { deal_id: ['deal-array'] },
    { deal_id: 42 },
    { deal_id: true },
    { deal_id: 'd'.repeat(257) },
    { deal_id: '', client_external_id: { tenant: 'external' } },
    { deal_id: '', client_external_id: ['external-array'] },
    { deal_id: '', client_external_id: 7 },
    { deal_id: '', client_external_id: 'e'.repeat(257) },
  ];
  for (const identityFields of invalidBodies) {
    const normalized = normalizeOnboarding(onboardingBody(identityFields));
    const claim = executeCodeNode(onboardingWorkflow, 'Build Claim Decision', {
      inputRows: [],
      nodeOutputs: { 'Normalize Onboarding': normalized },
    }).json;
    assert.equal(normalized.ok, false, JSON.stringify(identityFields).slice(0, 100));
    assert.equal(normalized.state, 'PRECONDITION_FAILED');
    assert.equal(normalized.onboarding_id, '');
    assert.equal(claim.should_insert_claim, false);
    for (const step of plannedSteps(normalized).filter((row) => row.child_day !== 'Parent')) {
      assert.equal(step.state, 'PRECONDITION_FAILED', `${step.step_name}:${JSON.stringify(identityFields).slice(0, 80)}`);
      assert.equal(step.predicted_child_key, '', `${step.step_name}:${JSON.stringify(identityFields).slice(0, 80)}`);
    }
  }
});

test('distinct deals cannot collide across predicted offer, invoice, booking, or document keys', () => {
  const shared = {
    verified_email: 'shared@example.test',
    file_sha256: 'c'.repeat(64),
    attachment_id: '',
  };
  const first = normalizeOnboarding(onboardingBody({ ...shared, deal_id: 'deal-owner-a' }));
  const second = normalizeOnboarding(onboardingBody({ ...shared, deal_id: 'deal-owner-b' }));
  assert.notEqual(first.onboarding_id, second.onboarding_id);

  for (const stepName of ['offer_out', 'first_invoice', 'kickoff_booking', 'signed_document']) {
    const left = plannedStep(first, stepName);
    const right = plannedStep(second, stepName);
    assert.ok(left.predicted_child_key, stepName);
    assert.ok(right.predicted_child_key, stepName);
    assert.notEqual(left.predicted_child_key, right.predicted_child_key, stepName);
  }

  for (const normalized of [first, second]) {
    const offer = plannedStep(normalized, 'offer_out');
    const document = plannedStep(normalized, 'signed_document');
    assert.equal(JSON.parse(offer.request_snapshot_bytes).onboarding_id, normalized.onboarding_id);
    const documentRequest = JSON.parse(document.request_snapshot_bytes);
    assert.equal(documentRequest.onboarding_id, normalized.onboarding_id);
    assert.equal(normalizeDocument(documentRequest).document_key, document.predicted_child_key);
  }
});

test('malformed document variants never produce a dispatchable child request', () => {
  const variants = [
    { name: 'raw OCR only', body: { filename: '', mime_type: '', attachment_id: '', file_sha256: '', ocr_text: longOcrText } },
    { name: 'missing attachment or hash', body: { attachment_id: '', file_sha256: '' } },
    { name: 'malformed hash', body: { attachment_id: 'attachment-still-present', file_sha256: 'not-a-sha256' } },
    { name: 'missing filename', body: { filename: '' } },
    { name: 'missing mime', body: { mime_type: '' } },
    { name: 'missing text', body: { ocr_text: '' } },
  ];
  for (const variant of variants) {
    const normalized = normalizeOnboarding(onboardingBody(variant.body));
    const step = plannedStep(normalized, 'signed_document');
    assert.notEqual(step.state, 'INTENT_WRITTEN', variant.name);
    assert.equal(step.predicted_child_key, '', variant.name);
    const child = normalizeDocument(JSON.parse(step.request_snapshot_bytes));
    assert.equal(child.invalid_input, true, variant.name);
  }
});

test('missing document remains an explicit waiting step and rolls the parent up as blocked', () => {
  const normalized = normalizeOnboarding(onboardingBody({
    filename: '',
    mime_type: '',
    attachment_id: '',
    file_sha256: '',
    ocr_text: '',
  }));
  const steps = plannedSteps(normalized);
  const document = plannedStep(normalized, 'signed_document');
  assert.equal(document.state, 'DOC_WAITING_UPLOAD');
  assert.equal(document.predicted_child_key, '');

  const offer = steps.find((step) => step.step_name === 'offer_out');
  const invoice = steps.find((step) => step.step_name === 'first_invoice');
  const booking = steps.find((step) => step.step_name === 'kickoff_booking');
  const decision = executeCodeNode(onboardingWorkflow, 'Build Parent Saga Decisions', {
    nodeOutputs: {
      'Normalize Onboarding': normalized,
      'Build Missing Step Intent Summary': {
        existing_step_rows_json: '[]',
        intent_rows_json: JSON.stringify(steps),
        replay_noop: false,
      },
    },
    nodeItems: {
      'Find Offer Rows': [{ submission_id: offer.predicted_child_key, onboarding_id: normalized.onboarding_id, smoke_tag: offer.smoke_tag, email_sent: true }],
      'Find Invoice Rows': [{ invoice_key: invoice.predicted_child_key, onboarding_id: invoice.onboarding_id, smoke_tag: invoice.smoke_tag, invoice_email_sent: true }],
      'Find Booking Rows': [{
        booking_uid: booking.predicted_child_key,
        onboarding_id: booking.onboarding_id,
        smoke_tag: booking.smoke_tag,
        status: 'confirmed',
        slot_start_utc: JSON.parse(booking.request_snapshot_bytes).slot_start,
      }],
      'Find Document Rows': [],
    },
  }).json;
  const documentDecision = JSON.parse(decision.response_body_json).decisions
    .find((step) => step.step_name === 'signed_document');
  const finalParent = JSON.parse(decision.final_onboarding_row_json);
  assert.equal(documentDecision.state, 'DOC_WAITING_UPLOAD');
  assert.equal(documentDecision.status, 'waiting_for_document_upload');
  assert.equal(decision.state, 'PARTIAL_BLOCKED');
  assert.match(finalParent.blocked_reason, /signed_document:waiting_for_document_upload/);
});

test('identical onboarding replays preserve all step and predicted child keys', () => {
  const body = onboardingBody({ deal_id: 'deal-stable-replay', service_code: 'ai_audit', quantity: 1 });
  const first = normalizeOnboarding(body);
  const second = normalizeOnboarding(body);
  assert.equal(first.onboarding_id, second.onboarding_id);
  assert.equal(first.current_payload_hash, second.current_payload_hash);
  assert.deepEqual(
    plannedSteps(first).map(({ step_name, step_key, predicted_child_key }) => ({ step_name, step_key, predicted_child_key })),
    plannedSteps(second).map(({ step_name, step_key, predicted_child_key }) => ({ step_name, step_key, predicted_child_key })),
  );
});
