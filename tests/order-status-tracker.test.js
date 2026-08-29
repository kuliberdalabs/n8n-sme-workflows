'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const { executeCodeNode, loadWorkflow, workflowFile } = require('./helpers/workflow-vm');

const orderWorkflow = workflowFile('10-order-status-tracker');
const annotatedWorkflow = orderWorkflow.replace('workflow.json', 'workflow-annotated-v2.json');
const strongVerifier = 'lookup-token-1042-example-safe';

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

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function intakeBody(overrides = {}) {
  return {
    tenant_key: 'example_store',
    order_id: 'ORDER-1042',
    customer_name: 'Ada Example',
    customer_email: 'ada@example.test',
    customer_status_token: strongVerifier,
    event_at_utc: '2026-09-01T09:00:00Z',
    source_event_id: 'commerce-event-1042',
    status: 'Received',
    reason: 'Order received',
    line_items: [{ sku: 'EXAMPLE-1', quantity: 1 }],
    smoke_tag: 'ORDER-TRACKER-TEST',
    ...overrides,
  };
}

function normalizeIntake(overrides = {}) {
  return executeCodeNode(orderWorkflow, 'Normalize Order Intake', {
    input: { body: intakeBody(overrides) },
  }).json;
}

function buildIntake(normalized, existingRows = []) {
  return executeCodeNode(orderWorkflow, 'Build Intake Actions', {
    inputRows: existingRows,
    nodeOutputs: { 'Normalize Order Intake': normalized },
  })[0].json;
}

function normalizeStatus(body) {
  return executeCodeNode(orderWorkflow, 'Normalize Status Update', {
    input: { body },
  });
}

function buildStatus(events, orderRows, historyRows = []) {
  return executeCodeNode(orderWorkflow, 'Build Status Actions', {
    inputRows: historyRows,
    nodeItems: {
      'Normalize Status Update': events.map((item) => item.json),
      'Find Status Order Rows': orderRows,
    },
  }).map((item) => item.json);
}

function routeStatusAction(action) {
  const deduped = executeCodeNode(orderWorkflow, 'Apply Status Notification Dedup', {
    inputRows: [{}],
    nodeItems: { 'Build Status Actions': [action] },
  }).map((item) => item.json);
  const persistable = executeCodeNode(orderWorkflow, 'Filter Status Persistable Transitions', {
    inputRows: deduped,
  });
  const held = executeCodeNode(orderWorkflow, 'Filter Status Held Actions', {
    inputRows: deduped,
  });
  const terminal = executeCodeNode(orderWorkflow, 'Filter Status Terminal No-Write Actions', {
    inputRows: deduped,
  });
  return { deduped, persistable, held, terminal };
}

function getField(row, path) {
  return path.split('.').reduce(
    (value, key) => (value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : ''),
    row,
  );
}

function evaluateExpression(value, { item = {}, nodeOutputs = {} } = {}) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('=')) return value;
  let expression = trimmed.slice(1).trim();
  if (expression.startsWith('{{') && expression.endsWith('}}')) {
    expression = expression.slice(2, -2).trim();
  }
  let match = expression.match(/^\$\('([^']+)'\)\.item\.json\.([A-Za-z0-9_.$]+)$/);
  if (match) return getField(nodeOutputs[match[1]] || {}, match[2]);
  match = expression.match(/^\$json\.([A-Za-z0-9_.$]+)$/);
  if (match) return getField(item, match[1]);
  throw new Error(`unsupported expression in test harness: ${value}`);
}

function tableBoundary(workflow, name, item, nodeOutputs = {}) {
  const node = nodeByName(workflow, name);
  assert.equal(node.type, 'n8n-nodes-base.dataTable');
  const values = node.parameters.columns?.value || {};
  const schema = new Map((node.parameters.columns?.schema || []).map((column) => [column.id, column.type]));
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    output[key] = evaluateExpression(value, { item, nodeOutputs });
    if (['date', 'dateTime'].includes(schema.get(key))) {
      assert.notEqual(output[key], '', `${name}.${key} must not map an empty date`);
    }
  }
  return output;
}

function gmailPayload(workflow, name, item, nodeOutputs = {}) {
  const node = nodeByName(workflow, name);
  assert.equal(node.type, 'n8n-nodes-base.gmail');
  return {
    sendTo: evaluateExpression(node.parameters.sendTo, { item, nodeOutputs }),
    subject: evaluateExpression(node.parameters.subject, { item, nodeOutputs }),
    message: evaluateExpression(node.parameters.message, { item, nodeOutputs }),
  };
}

test('separate owner variables fail closed and each token authorizes only its own lane', () => {
  const intakeMissing = executeCodeNode(orderWorkflow, 'Validate Intake Token', {
    input: { headers: { 'x-order-status-token': 'status-token' }, body: {} },
  }).json;
  assert.equal(intakeMissing.auth_ok, false);
  assert.equal(intakeMissing.auth_reason, 'missing_server_token_var_ORDER_INTAKE_TOKEN');

  const statusMissing = executeCodeNode(orderWorkflow, 'Validate Status Token', {
    input: { headers: { 'x-order-intake-token': 'intake-token' }, body: {} },
  }).json;
  assert.equal(statusMissing.auth_ok, false);
  assert.equal(statusMissing.auth_reason, 'missing_server_token_var_ORDER_STATUS_TOKEN');

  const intakeWrongLane = executeCodeNode(orderWorkflow, 'Validate Intake Token', {
    input: { headers: { 'x-order-status-token': 'shared-looking-value' } },
    vars: { ORDER_INTAKE_TOKEN: 'shared-looking-value' },
  }).json;
  assert.equal(intakeWrongLane.auth_ok, false);

  const intakeOk = executeCodeNode(orderWorkflow, 'Validate Intake Token', {
    input: { headers: { 'x-order-intake-token': 'intake-token' } },
    vars: { ORDER_INTAKE_TOKEN: 'intake-token' },
  }).json;
  const statusOk = executeCodeNode(orderWorkflow, 'Validate Status Token', {
    input: { headers: { authorization: 'Bearer status-token' } },
    vars: { ORDER_STATUS_TOKEN: 'status-token' },
  }).json;
  assert.equal(intakeOk.auth_ok, true);
  assert.equal(statusOk.auth_ok, true);
});

test('happy intake derives stable generic keys and creates one controlled notification action', () => {
  const normalized = normalizeIntake();
  assert.deepEqual(normalized.validation_errors, []);
  assert.equal(normalized.source_role, 'intake');
  assert.equal(normalized.source_channel, 'order-intake-webhook');
  assert.match(normalized.order_key, /^[a-f0-9]{64}$/);
  assert.match(normalized.event_key, /^[a-f0-9]{64}$/);
  assert.match(normalized.notification_key, /^[a-f0-9]{64}$/);
  assert.equal(normalized.order_key, hash('order-tracker:order:example_store:order-1042'));
  assert.equal(normalized.customer_verifier_hash, hash(`order-tracker-verifier:${normalized.order_key}:${strongVerifier}`));

  const action = buildIntake(normalized);
  assert.equal(action.should_insert_order, true);
  assert.equal(action.should_send_email, true);
  assert.equal(action.controlled_recipient, 'ops@example.com');
  assert.equal(action.notification_status, 'Pending Send');
  assert.equal(action.response_status, 'accepted_pending_controlled_email');
});

test('intake mappings survive Data Table output replacement through History, Notification, Gmail, and order update', () => {
  const workflow = loadWorkflow(orderWorkflow);
  const action = buildIntake(normalizeIntake());
  const filterOutputs = { 'Filter Intake Sendable Notifications': action };

  const orderRow = tableBoundary(workflow, 'Insert Intake Order Row', action, filterOutputs);
  assert.equal(orderRow.order_id, action.order_id);
  assert.equal(orderRow.history_key, undefined);

  const historyRow = tableBoundary(workflow, 'Insert Intake Status History Row', orderRow, filterOutputs);
  assert.equal(historyRow.order_id, action.order_id);
  assert.equal(historyRow.event_key, action.last_event_key);
  assert.equal(historyRow.notification_key, action.notification_key);
  assert.equal(historyRow.action, 'insert_order_and_notify');

  const notificationRow = tableBoundary(workflow, 'Insert Intake Notification Pending Row', historyRow, filterOutputs);
  assert.equal(notificationRow.notification_key, action.notification_key);
  assert.match(notificationRow.email_subject, /Order ORDER-1042 Received/);
  assert.match(notificationRow.email_body_html, /ORDER-1042/);

  const gmail = gmailPayload(workflow, 'Send Controlled Intake Status Email', notificationRow, filterOutputs);
  assert.equal(gmail.sendTo, 'ops@example.com');
  assert.equal(gmail.subject, action.email_subject);
  assert.equal(gmail.message, action.email_body_html);

  const sent = executeCodeNode(orderWorkflow, 'Build Intake Sent Updates', {
    input: { id: 'gmail-message-intake-1' },
    nodeOutputs: { 'Filter Intake Sendable Notifications': action },
  }).json;
  const notificationUpdate = tableBoundary(workflow, 'Update Intake Notification Sent', sent);
  assert.equal(notificationUpdate.email_sent, true);
  assert.equal(notificationUpdate.test_email_id, 'gmail-message-intake-1');
  assert.equal(notificationUpdate.delivery_status, 'Sent Controlled');
  assert.equal(notificationUpdate.send_error, '');
  const orderUpdate = tableBoundary(workflow, 'Update Intake Order Notified', notificationUpdate, {
    'Build Intake Sent Updates': sent,
  });
  assert.equal(orderUpdate.last_email_id, 'gmail-message-intake-1');
  assert.equal(orderUpdate.notification_status, 'Sent Controlled');
});

test('Gmail error or missing provider id stays Pending Send through both durable update mappings', () => {
  const workflow = loadWorkflow(orderWorkflow);
  const action = buildIntake(normalizeIntake());
  const failed = executeCodeNode(orderWorkflow, 'Build Intake Sent Updates', {
    input: { error: 'credential_missing' },
    nodeOutputs: { 'Filter Intake Sendable Notifications': action },
  }).json;
  assert.equal(failed.email_sent, false);
  assert.equal(failed.test_email_id, '');
  assert.equal(failed.last_notified_status, '');
  assert.equal(failed.notification_status, 'Pending Send');
  assert.equal(failed.response_status, 'send_failed_pending_retry');
  assert.ok(failed.pending_since_utc);

  const notificationUpdate = tableBoundary(workflow, 'Update Intake Notification Sent', failed);
  assert.equal(notificationUpdate.delivery_status, 'Pending Send');
  assert.equal(notificationUpdate.email_sent, false);
  assert.match(notificationUpdate.send_error, /credential_missing/);
  const orderUpdate = tableBoundary(workflow, 'Update Intake Order Notified', notificationUpdate, {
    'Build Intake Sent Updates': failed,
  });
  assert.equal(orderUpdate.notification_status, 'Pending Send');
  assert.equal(orderUpdate.last_email_id, '');
});

test('sent milestone re-entry persists Order and History without another Notification or Gmail send', () => {
  const normalizedIntake = normalizeIntake();
  const order = {
    ...buildIntake(normalizedIntake),
    customer_visible_status: 'Blocked',
    status_rank: 25,
    last_event_key: 'blocked-event',
    last_status_at_utc: '2026-09-01T10:00:00.000Z',
    notification_status: 'Sent Controlled',
    last_notification_key: 'blocked-notification-key',
    last_email_id: 'gmail-blocked-1',
  };
  const events = normalizeStatus({
    tenant_key: 'example_store',
    order_id: 'ORDER-1042',
    status: 'Confirmed',
    event_at_utc: '2026-09-01T11:00:00Z',
    source_event_id: 'confirmed-reentry-event',
  });
  const action = buildStatus(events, [order])[0];
  assert.equal(action.should_persist_transition, true);
  assert.equal(action.should_send_email, true);

  const deduped = executeCodeNode(orderWorkflow, 'Apply Status Notification Dedup', {
    inputRows: [
      { notification_key: action.notification_key, email_sent: false, test_email_id: '' },
      {
        notification_key: action.notification_key,
        email_sent: true,
        test_email_id: 'gmail-confirmed-original',
        updated_at_utc: '2026-09-01T09:30:00.000Z',
      },
    ],
    nodeItems: { 'Build Status Actions': [action] },
  })[0].json;
  assert.equal(deduped.should_persist_transition, true);
  assert.equal(deduped.should_send_email, false);
  assert.equal(deduped.action, 'update_order_without_repeat_notification');
  assert.equal(deduped.response_status, 'status_updated_notification_already_sent');
  assert.equal(deduped.customer_visible_status, 'Confirmed');
  assert.equal(deduped.last_event_key, events[0].json.event_key);
  assert.equal(deduped.last_notified_status, 'Confirmed');
  assert.equal(deduped.last_email_id, 'gmail-confirmed-original');
  assert.equal(deduped.ledger_dedup_hit, true);

  const workflow = loadWorkflow(orderWorkflow);
  const persistable = executeCodeNode(orderWorkflow, 'Filter Status Persistable Transitions', {
    inputRows: [deduped],
  });
  assert.equal(persistable.length, 1);

  const orderUpdate = tableBoundary(workflow, 'Update Status Order Transition', deduped);
  assert.equal(orderUpdate.customer_visible_status, 'Confirmed');
  assert.equal(orderUpdate.last_event_key, events[0].json.event_key);
  assert.equal(orderUpdate.notification_status, 'Sent Controlled');
  assert.equal(orderUpdate.last_notification_key, action.notification_key);
  assert.equal(orderUpdate.last_notified_status, 'Confirmed');
  assert.equal(orderUpdate.last_email_id, 'gmail-confirmed-original');

  const history = tableBoundary(workflow, 'Insert Status History Row', orderUpdate, {
    'Filter Status Persistable Transitions': deduped,
  });
  assert.equal(history.event_key, events[0].json.event_key);
  assert.equal(history.from_status, 'Blocked');
  assert.equal(history.to_status, 'Confirmed');
  assert.equal(history.action, 'update_order_without_repeat_notification');

  const sendable = executeCodeNode(orderWorkflow, 'Filter Status Sendable Notifications', {
    input: history,
    nodeItems: { 'Filter Status Persistable Transitions': [deduped] },
  });
  const persistedWithoutEmail = executeCodeNode(orderWorkflow, 'Filter Status Persisted Without Email', {
    input: history,
    nodeItems: { 'Filter Status Persistable Transitions': [deduped] },
  });
  assert.equal(sendable.length, 0);
  assert.equal(persistedWithoutEmail.length, 1);
  assert.deepEqual({
    orderUpdates: persistable.length,
    historyInserts: persistable.length,
    notificationInserts: sendable.length,
    gmailSends: sendable.length,
  }, {
    orderUpdates: 1,
    historyInserts: 1,
    notificationInserts: 0,
    gmailSends: 0,
  });
  assert.deepEqual(directSuccessors(workflow, 'Filter Status Persisted Without Email'), [
    'Build Status Terminal Response',
  ]);
  assert.deepEqual(directSuccessors(workflow, 'Filter Status Sendable Notifications'), [
    'Insert Status Notification Pending Row',
  ]);

  for (const name of ['Find Intake Existing Notification Row', 'Find Status Existing Notification Row']) {
    const lookup = nodeByName(workflow, name);
    assert.equal(lookup.parameters.returnAll, true);
    assert.equal(Object.prototype.hasOwnProperty.call(lookup.parameters, 'limit'), false);
  }
});

test('duplicate intake is terminal and creates no new row, history event, or email action', () => {
  const normalized = normalizeIntake();
  const first = buildIntake(normalized);
  const duplicate = buildIntake(normalized, [{
    order_key: first.order_key,
    customer_visible_status: first.customer_visible_status,
  }]);
  assert.equal(duplicate.action, 'duplicate_intake');
  assert.equal(duplicate.should_insert_order, false);
  assert.equal(duplicate.should_persist_hold, false);
  assert.equal(duplicate.should_send_email, false);
  assert.equal(duplicate.response_status, 'duplicate_ignored');
});

test('missing tenant, event id, malformed timestamp, and incomplete intake are held without email', () => {
  const invalid = executeCodeNode(orderWorkflow, 'Normalize Order Intake', {
    input: {
      body: {
        customer_status_token: strongVerifier,
        event_at_utc: '2026-09-01 09:00',
        status: 'Received',
      },
    },
  }).json;
  assert.match(invalid.validation_errors.join(','), /missing_tenant_key/);
  assert.match(invalid.validation_errors.join(','), /missing_order_id/);
  assert.match(invalid.validation_errors.join(','), /missing_event_id/);
  assert.match(invalid.validation_errors.join(','), /timestamp_missing_explicit_offset/);
  assert.equal(invalid.order_key, '');

  const action = buildIntake(invalid);
  assert.equal(action.should_send_email, false);
  assert.equal(action.should_persist_hold, true);
  assert.equal(action.response_code, 422);
  assert.match(action.reason, /missing_tenant_key/);
});

test('intake verifier must be an exact unpadded 24 to 256 character secret', () => {
  const short = normalizeIntake({ customer_status_token: 'too-short' });
  assert.match(short.validation_errors.join(','), /customer_status_token_must_be_24_to_256_chars/);
  assert.equal(short.customer_verifier_hash, '');

  const padded = normalizeIntake({ customer_status_token: ` ${strongVerifier} ` });
  assert.match(padded.validation_errors.join(','), /customer_status_token_must_not_have_padding/);
  assert.equal(padded.customer_verifier_hash, '');

  const missingEventId = normalizeIntake({ source_event_id: '', event_id: '' });
  assert.match(missingEventId.validation_errors.join(','), /missing_event_id/);
});

test('untrusted intake and status text is escaped and whitespace-collapsed before Gmail HTML', () => {
  const normalized = normalizeIntake({
    order_id: 'ORDER-<img src=x onerror=alert(1)>',
    reason: 'line\n<script>alert(1)</script>\ttext',
  });
  const action = buildIntake(normalized);
  assert.doesNotMatch(action.email_body_html, /<script|<img/i);
  assert.match(action.email_body_html, /&lt;script&gt;/);
  assert.match(action.email_body_html, /&lt;img/);
  assert.doesNotMatch(action.email_body_html, /\n|\t/);

  const baseOrder = {
    ...buildIntake(normalizeIntake()),
    customer_visible_status: 'Received',
    last_event_key: 'old',
  };
  const events = normalizeStatus({
    tenant_key: 'example_store',
    order_id: 'ORDER-1042',
    status: 'Confirmed',
    event_at_utc: '2026-09-01T10:00:00Z',
    source_event_id: 'confirmed-injection',
    reason: 'Ready\t for\n   approval <img src=x onerror=alert(1)>',
  });
  const status = buildStatus(events, [baseOrder])[0];
  assert.doesNotMatch(status.email_body_html, /<img/i);
  assert.match(status.email_body_html, /Ready for approval &lt;img/);
  assert.doesNotMatch(status.email_body_html, /\n|\t| {2,}/);
});

test('status normalization rejects arrays and non-object bodies as one held item without throwing', () => {
  const order = {
    ...buildIntake(normalizeIntake()),
    customer_visible_status: 'Received',
    last_event_key: 'old',
  };
  const arrayAttempt = normalizeStatus({
    events: [
      {
        tenant_key: 'example_store', order_id: 'ORDER-1042', status: 'Confirmed',
        event_at_utc: '2026-09-01T10:00:00Z', source_event_id: 'confirmed-hit',
      },
    ],
  });
  assert.equal(arrayAttempt.length, 1);
  assert.match(arrayAttempt[0].json.validation_errors.join(','), /events_array_not_supported/);
  const held = buildStatus(arrayAttempt, [order]);
  assert.equal(held.length, 1);
  assert.equal(held[0].response_code, 422);
  assert.equal(held[0].should_send_email, false);

  for (const body of [null, 'not-an-object', []]) {
    const normalized = normalizeStatus(body);
    assert.equal(normalized.length, 1);
    assert.match(normalized[0].json.validation_errors.join(','), /request_body_must_be_object/);
  }
});

test('status mappings preserve action fields across Data Table output replacement and provider acknowledgement', () => {
  const workflow = loadWorkflow(orderWorkflow);
  const order = {
    ...buildIntake(normalizeIntake()),
    customer_visible_status: 'Received',
    last_event_key: 'old',
  };
  const events = normalizeStatus({
    tenant_key: 'example_store',
    order_id: 'ORDER-1042',
    status: 'Confirmed',
    event_at_utc: '2026-09-01T10:00:00Z',
    source_event_id: 'confirmed-boundary',
    reason: 'Ready for approval',
  });
  const action = buildStatus(events, [order])[0];
  const filterOutputs = {
    'Filter Status Persistable Transitions': action,
    'Filter Status Sendable Notifications': action,
  };

  const pendingOrder = tableBoundary(workflow, 'Update Status Order Transition', action, filterOutputs);
  assert.equal(pendingOrder.customer_visible_status, 'Confirmed');
  assert.equal(pendingOrder.event_key, undefined);
  const history = tableBoundary(workflow, 'Insert Status History Row', pendingOrder, filterOutputs);
  assert.equal(history.event_key, action.event_key);
  assert.equal(history.from_status, 'Received');
  assert.equal(history.to_status, 'Confirmed');
  const notification = tableBoundary(workflow, 'Insert Status Notification Pending Row', history, filterOutputs);
  assert.equal(notification.notification_key, action.notification_key);
  assert.equal(notification.email_subject, action.email_subject);
  const gmail = gmailPayload(workflow, 'Send Controlled Status Update Email', notification, filterOutputs);
  assert.equal(gmail.subject, action.email_subject);
  assert.match(gmail.message, /Ready for approval/);

  const sent = executeCodeNode(orderWorkflow, 'Build Status Sent Updates', {
    input: { id: 'gmail-message-status-1' },
    nodeOutputs: { 'Filter Status Sendable Notifications': action },
  }).json;
  const notificationUpdate = tableBoundary(workflow, 'Update Status Notification Sent', sent);
  assert.equal(notificationUpdate.delivery_status, 'Sent Controlled');
  const orderUpdate = tableBoundary(workflow, 'Update Status Order Notified', notificationUpdate, {
    'Build Status Sent Updates': sent,
  });
  assert.equal(orderUpdate.customer_visible_status, 'Confirmed');
  assert.equal(orderUpdate.last_email_id, 'gmail-message-status-1');
});

test('explicit edge matrix blocks regression, sequence jumps, terminal exits, unchanged state, and customer cancellation', () => {
  const base = buildIntake(normalizeIntake());
  const run = (current, target, extra = {}) => {
    const events = normalizeStatus({
      tenant_key: 'example_store',
      order_id: 'ORDER-1042',
      status: target,
      event_at_utc: '2026-09-01T11:00:00Z',
      source_event_id: `event-${current}-${target}`,
    });
    events[0].json = { ...events[0].json, ...extra };
    return buildStatus(events, [{ ...base, customer_visible_status: current, last_event_key: 'old' }])[0];
  };

  const shippedToBlocked = run('Shipped', 'Blocked');
  assert.equal(shippedToBlocked.should_send_email, false);
  assert.match(shippedToBlocked.reason, /transition_not_allowed_Shipped_to_Blocked/);

  const receivedToCollected = run('Received', 'Collected');
  assert.equal(receivedToCollected.should_send_email, false);
  assert.match(receivedToCollected.reason, /transition_not_allowed_Received_to_Collected/);

  const terminalExit = run('Collected', 'Ready');
  assert.equal(terminalExit.should_send_email, false);
  assert.match(terminalExit.reason, /terminal_state_blocks_transition/);

  const unchanged = run('Ready', 'Ready');
  assert.equal(unchanged.action, 'unchanged_status_ignored');
  assert.equal(unchanged.should_persist_hold, false);

  const defensiveCustomerCancel = run('Ready', 'Cancelled', { source_role: 'customer' });
  assert.equal(defensiveCustomerCancel.should_send_email, false);
  assert.match(defensiveCustomerCancel.reason, /customer_cancelled_requires_confirmation/);

  assert.equal(run('Shipped', 'Collected').should_send_email, true);
});

test('status event id is required and owns the stable key independently of mutable status', () => {
  const order = {
    ...buildIntake(normalizeIntake()),
    customer_visible_status: 'Received',
    last_event_key: 'old',
  };
  const missing = normalizeStatus({
    tenant_key: 'example_store', order_id: 'ORDER-1042', status: 'Confirmed',
    event_at_utc: '2026-09-01T12:00:00Z',
  });
  assert.match(missing[0].json.validation_errors.join(','), /missing_event_id/);
  const held = buildStatus(missing, [order])[0];
  assert.equal(held.response_code, 422);
  assert.equal(held.should_send_email, false);

  const first = normalizeStatus({
    tenant_key: 'example_store', order_id: 'ORDER-1042', status: 'Confirmed',
    event_at_utc: '2026-09-01T12:00:00Z', source_event_id: 'stable-event-1',
  });
  const mutated = normalizeStatus({
    tenant_key: 'example_store', order_id: 'ORDER-1042', status: 'Cancelled',
    event_at_utc: '2026-09-01T12:01:00Z', source_event_id: 'stable-event-1',
  });
  assert.equal(first[0].json.event_key, mutated[0].json.event_key);
});

test('strictly older status events are held while distinct same-time ids follow the edge matrix', () => {
  const order = {
    ...buildIntake(normalizeIntake()),
    customer_visible_status: 'Received',
    last_event_key: 'previous-event',
    last_status_at_utc: '2026-09-01T12:00:00.000Z',
  };
  const older = normalizeStatus({
    tenant_key: 'example_store', order_id: 'ORDER-1042', status: 'Confirmed',
    event_at_utc: '2026-09-01T11:59:59Z', source_event_id: 'older-event',
  });
  const stale = buildStatus(older, [order])[0];
  assert.equal(stale.should_send_email, false);
  assert.equal(stale.should_persist_hold, true);
  assert.match(stale.reason, /stale_status_event/);
  assert.equal(stale.last_status_at_utc, order.last_status_at_utc);

  const sameTime = normalizeStatus({
    tenant_key: 'example_store', order_id: 'ORDER-1042', status: 'Confirmed',
    event_at_utc: '2026-09-01T12:00:00Z', source_event_id: 'same-time-distinct-id',
  });
  const allowed = buildStatus(sameTime, [order])[0];
  assert.equal(allowed.should_send_email, true);
  assert.doesNotMatch(allowed.reason, /stale_status_event/);
});

test('durable History suppresses an older accepted event replay before stale and edge evaluation', () => {
  const base = buildIntake(normalizeIntake());
  const events = normalizeStatus({
    tenant_key: 'example_store',
    order_id: 'ORDER-1042',
    status: 'Confirmed',
    event_at_utc: '2026-09-01T10:00:00Z',
    source_event_id: 'accepted-event-e1',
  });
  const actions = buildStatus(events, [{
    ...base,
    customer_visible_status: 'In Production',
    last_event_key: 'newer-event-e2',
    last_status_at_utc: '2026-09-01T11:00:00.000Z',
  }], [{
    event_key: events[0].json.event_key,
    event_type: 'status_changed',
    from_status: 'Received',
    to_status: 'Confirmed',
  }, {
    event_key: events[0].json.event_key,
    event_type: 'status_update_held',
    from_status: 'Received',
    to_status: 'Confirmed',
  }]);
  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.action, 'duplicate_replay_ignored');
  assert.equal(action.should_send_email, false);
  assert.equal(action.should_persist_hold, false);
  assert.equal(action.should_persist_transition, false);
  assert.equal(action.reason, 'replay_duplicate_event');
  assert.doesNotMatch(action.reason, /stale_status_event|transition_not_allowed/);

  const route = routeStatusAction(action);
  assert.equal(route.persistable.length, 0);
  assert.equal(route.held.length, 0);
  assert.equal(route.terminal.length, 1);
  const response = executeCodeNode(orderWorkflow, 'Build Status Terminal Response', {
    input: route.terminal[0].json,
  }).json;
  assert.equal(response.response_code, 200);
  assert.equal(response.status, 'duplicate_ignored');
  assert.deepEqual({
    orderWrites: route.persistable.length,
    historyWrites: route.persistable.length + route.held.length,
    notificationWrites: 0,
    gmailSends: 0,
    statusResponses: route.terminal.length,
  }, {
    orderWrites: 0,
    historyWrites: 0,
    notificationWrites: 0,
    gmailSends: 0,
    statusResponses: 1,
  });
});

test('durable History suppresses a previously-held event even after its transition becomes allowed', () => {
  const base = buildIntake(normalizeIntake());
  const events = normalizeStatus({
    tenant_key: 'example_store',
    order_id: 'ORDER-1042',
    status: 'Ready',
    event_at_utc: '2026-09-01T12:00:00Z',
    source_event_id: 'previously-held-event',
  });
  const action = buildStatus(events, [{
    ...base,
    customer_visible_status: 'In Production',
    last_event_key: 'later-production-event',
    last_status_at_utc: '2026-09-01T13:00:00.000Z',
  }], [{
    event_key: events[0].json.event_key,
    event_type: 'status_update_held',
    from_status: 'Confirmed',
    to_status: 'Ready',
    action: 'held_status_update',
  }])[0];
  assert.equal(action.action, 'duplicate_replay_ignored');
  assert.equal(action.reason, 'replay_duplicate_event');
  assert.equal(action.should_persist_transition, false);
  assert.equal(action.should_persist_hold, false);
  assert.equal(action.should_send_email, false);

  const route = routeStatusAction(action);
  assert.equal(route.persistable.length, 0);
  assert.equal(route.held.length, 0);
  assert.equal(route.terminal.length, 1);
  const response = executeCodeNode(orderWorkflow, 'Build Status Terminal Response', {
    input: route.terminal[0].json,
  }).json;
  assert.equal(response.response_code, 200);
  assert.equal(response.status, 'duplicate_ignored');
  assert.deepEqual({
    orderWrites: route.persistable.length,
    historyWrites: route.persistable.length + route.held.length,
    notificationWrites: 0,
    gmailSends: 0,
    statusResponses: route.terminal.length,
  }, {
    orderWrites: 0,
    historyWrites: 0,
    notificationWrites: 0,
    gmailSends: 0,
    statusResponses: 1,
  });
});

test('customer lookup requires tenant plus verifier and exposes only the four-field safe projection', () => {
  const normalized = normalizeIntake();
  const order = {
    ...buildIntake(normalized),
    updated_at_utc: '2026-09-01T14:00:00.000Z',
    safe_projection_json: JSON.stringify({ message: 'Your order is ready.' }),
    last_event_key: 'private-event-key',
    order_notes: 'private notes',
  };
  const lookup = executeCodeNode(orderWorkflow, 'Normalize Status Lookup', {
    input: {
      body: {
        tenant_key: 'example_store',
        order_id: 'ORDER-1042',
        customer_status_token: strongVerifier,
      },
    },
  }).json;
  const found = executeCodeNode(orderWorkflow, 'Build Safe Lookup Response', {
    inputRows: [order],
    nodeOutputs: { 'Normalize Status Lookup': lookup },
  }).json;
  assert.equal(found.ok, true);
  assert.deepEqual(Object.keys(found.order).sort(), [
    'customer_visible_status', 'message', 'order_id', 'updated_at_utc',
  ]);
  assert.equal(found.order.last_event_key, undefined);
  assert.equal(found.order.order_notes, undefined);

  const wrong = executeCodeNode(orderWorkflow, 'Normalize Status Lookup', {
    input: {
      body: {
        tenant_key: 'example_store',
        order_id: 'ORDER-1042',
        customer_status_token: 'wrong',
      },
    },
  }).json;
  const denied = executeCodeNode(orderWorkflow, 'Build Safe Lookup Response', {
    inputRows: [order],
    nodeOutputs: { 'Normalize Status Lookup': wrong },
  }).json;
  assert.deepEqual(denied, {
    ok: false,
    status: 'not_found',
    reason: 'order_not_found_or_bad_verifier',
  });

  const missingTenant = executeCodeNode(orderWorkflow, 'Normalize Status Lookup', {
    input: { body: { order_id: 'ORDER-1042', customer_status_token: strongVerifier } },
  }).json;
  assert.equal(missingTenant.lookup_ok, false);
  assert.equal(missingTenant.order_key, '');
});

test('stale sweep reports old Pending Send rows only and escapes operator HTML', () => {
  const result = executeCodeNode(orderWorkflow, 'Build Stale Pending Summary', {
    inputRows: [
      {
        order_key: 'old', order_id: 'OLD-<img src=x>', customer_visible_status: 'Ready',
        notification_status: 'Pending Send', pending_since_utc: '2020-01-01T00:00:00Z',
      },
      {
        order_key: 'sent', order_id: 'SENT', customer_visible_status: 'Ready',
        notification_status: 'Sent Controlled', pending_since_utc: '2020-01-01T00:00:00Z',
      },
      {
        order_key: 'future', order_id: 'FUTURE', customer_visible_status: 'Ready',
        notification_status: 'Pending Send', pending_since_utc: '2999-01-01T00:00:00Z',
      },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].json.stale_alert_needed, true);
  assert.equal(result[0].json.stale_count, 1);
  assert.doesNotMatch(result[0].json.report_html, /SENT|FUTURE|<img/i);
  assert.match(result[0].json.email_subject, /^\[ORDER STATUS\]/);
});

test('graph keeps intake, internal status, public lookup, and stale lanes separated', () => {
  const workflow = loadWorkflow(orderWorkflow);
  assert.deepEqual(directSuccessors(workflow, 'Order Intake Webhook'), ['Validate Intake Token']);
  assert.deepEqual(directSuccessors(workflow, 'Intake Token Authorized?', 0), ['Normalize Order Intake']);
  assert.deepEqual(directSuccessors(workflow, 'Intake Token Authorized?', 1), ['Respond Intake Unauthorized']);
  assert.deepEqual(directSuccessors(workflow, 'Status Token Authorized?', 0), ['Normalize Status Update']);
  assert.deepEqual(directSuccessors(workflow, 'Status Token Authorized?', 1), ['Build Status Terminal Response']);
  assert.deepEqual(directSuccessors(workflow, 'Find Status Order Rows'), ['Find Status Event History Rows']);
  assert.deepEqual(directSuccessors(workflow, 'Find Status Event History Rows'), ['Build Status Actions']);
  assert.deepEqual(directSuccessors(workflow, 'Apply Status Notification Dedup'), [
    'Filter Status Persistable Transitions',
    'Filter Status Held Actions',
    'Filter Status Terminal No-Write Actions',
  ]);
  assert.deepEqual(directSuccessors(workflow, 'Insert Status History Row'), [
    'Filter Status Sendable Notifications',
    'Filter Status Persisted Without Email',
  ]);

  const intakeReach = reachable(workflow, 'Order Intake Webhook');
  assert.equal(intakeReach.has('Normalize Status Update'), false);
  assert.equal(intakeReach.has('Build Status Actions'), false);
  const statusReach = reachable(workflow, 'Status Update Webhook');
  assert.equal(statusReach.has('Normalize Order Intake'), false);
  assert.equal(statusReach.has('Insert Intake Order Row'), false);
  const statusResponders = [...statusReach].filter(
    (name) => nodeByName(workflow, name).type === 'n8n-nodes-base.respondToWebhook',
  );
  assert.deepEqual(statusResponders, ['Respond Status Update']);

  const lookupReach = reachable(workflow, 'Customer Status Lookup Webhook');
  assert.equal(lookupReach.has('Build Safe Lookup Response'), true);
  for (const name of lookupReach) {
    const node = nodeByName(workflow, name);
    assert.notEqual(node.type, 'n8n-nodes-base.gmail');
    if (node.type === 'n8n-nodes-base.dataTable') assert.equal(node.parameters.operation, 'get');
  }
});

test('workflow is inactive, credential-free, native-only, and uses exact generic placeholders', () => {
  const workflow = loadWorkflow(orderWorkflow);
  const raw = fs.readFileSync(orderWorkflow, 'utf8');
  assert.equal(workflow.name, 'Order Status Tracker');
  assert.equal(workflow.active, false);
  assert.deepEqual(Object.keys(workflow).sort(), ['active', 'connections', 'name', 'nodes', 'settings', 'tags']);
  assert.equal(workflow.settings.executionOrder, 'v1');
  assert.equal(workflow.settings.timezone, 'UTC');
  assert.equal(Object.prototype.hasOwnProperty.call(workflow.settings, 'availableInMCP'), false);
  assert.equal(workflow.nodes.length, 59);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.webhook').length, 3);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.dataTable').length, 19);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.gmail').length, 3);
  assert.doesNotMatch(raw, /Day10|DAY10|day10|AR_|ar-day|demo_shop|kuliberda\.ai@gmail\.com/);
  assert.doesNotMatch(raw, /lNIWU5a2vnaHx4Cs|VAED6j2jSo22nZ4D|ULcS3Uyvww4QSPgu/);
  assert.equal(Object.prototype.hasOwnProperty.call(workflow, 'pinData'), false);

  const tableIds = new Set();
  for (const node of workflow.nodes) {
    assert.ok(node.type.startsWith('n8n-nodes-base.'), `${node.name} must be native`);
    assert.equal(Object.prototype.hasOwnProperty.call(node, 'credentials'), false, node.name);
    if (node.type === 'n8n-nodes-base.dataTable') {
      assert.equal(node.onError, 'stopWorkflow', `${node.name} must fail stop`);
      tableIds.add(node.parameters.dataTableId.value);
    }
  }
  assert.deepEqual([...tableIds].sort(), [
    'REPLACE_WITH_NOTIFICATIONS_TABLE_ID',
    'REPLACE_WITH_ORDERS_TABLE_ID',
    'REPLACE_WITH_STATUS_HISTORY_TABLE_ID',
  ]);

  const gmail = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.gmail');
  assert.ok(gmail.every((node) => node.typeVersion === 2.2));
  assert.ok(gmail.every((node) => node.parameters.resource === 'message'));
  assert.ok(gmail.every((node) => node.parameters.operation === 'send'));
  assert.ok(gmail.every((node) => node.parameters.sendTo === 'ops@example.com'));

  const historyReplayLookup = nodeByName(workflow, 'Find Status Event History Rows');
  assert.equal(historyReplayLookup.parameters.operation, 'get');
  assert.equal(historyReplayLookup.parameters.dataTableId.value, 'REPLACE_WITH_STATUS_HISTORY_TABLE_ID');
  assert.equal(historyReplayLookup.parameters.returnAll, true);
  assert.equal(historyReplayLookup.alwaysOutputData, true);
  assert.equal(historyReplayLookup.onError, 'stopWorkflow');
  assert.deepEqual(historyReplayLookup.parameters.filters.conditions, [{
    keyName: 'event_key',
    condition: 'eq',
    keyValue: "={{ $('Normalize Status Update').item.json.event_key }}",
  }]);
});

test('canonical and annotated artifacts preserve exact behavior outside positions and sticky notes', {
  skip: !fs.existsSync(annotatedWorkflow),
}, () => {
  const canonical = loadWorkflow(orderWorkflow);
  const annotated = loadWorkflow(annotatedWorkflow);
  const normalizeArtifact = (workflow) => ({
    ...workflow,
    nodes: workflow.nodes
      .filter((node) => node.type !== 'n8n-nodes-base.stickyNote')
      .map(({ position, ...node }) => node),
  });
  assert.deepEqual(normalizeArtifact(annotated), normalizeArtifact(canonical));
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(annotatedWorkflow)).digest('hex').length,
    64,
  );
});
