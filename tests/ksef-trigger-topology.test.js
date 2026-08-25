import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { validate } from '../scripts/creators-annotations.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SLUG = '07-ksef-exception-desk';
const WORKFLOW_PATH = resolve(ROOT, 'workflows', SLUG, 'workflow.json');
const ANNOTATED_PATH = resolve(ROOT, 'workflows', SLUG, 'workflow-annotated-v2.json');
const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const annotated = JSON.parse(readFileSync(ANNOTATED_PATH, 'utf8'));

function outgoing(nodeName, graph = workflow) {
  return graph.connections[nodeName]?.main ?? [];
}

function outputTargets(nodeName, graph = workflow) {
  return outgoing(nodeName, graph).map((edges) => edges.map((edge) => edge.node));
}

function evaluateRouter(mode, includeVariable = true) {
  const router = workflow.nodes.find((node) => node.name === 'Route Manual Sweep');
  const expression = router.parameters.output
    .replace(/^=\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  const vars = includeVariable ? { KSEF_MANUAL_SWEEP_MODE: mode } : {};
  return Function('$vars', `"use strict"; return (${expression});`)(vars);
}

function incomingSources(nodeName, graph = workflow) {
  const sources = [];
  for (const [sourceName, connectionTypes] of Object.entries(graph.connections)) {
    for (const outputs of Object.values(connectionTypes)) {
      for (const edges of outputs) {
        if ((edges ?? []).some((edge) => edge.node === nodeName)) sources.push(sourceName);
      }
    }
  }
  return sources;
}

test('KSeF exposes one safe manual selector with three isolated sweep outputs', () => {
  const manualTriggers = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.manualTrigger');
  assert.deepEqual(manualTriggers.map((node) => node.name), ['KSeF Manual Sweep']);
  assert.deepEqual(outputTargets('KSeF Manual Sweep'), [['Route Manual Sweep']]);

  const router = workflow.nodes.find((node) => node.name === 'Route Manual Sweep');
  assert.ok(router, 'manual selector router must exist');
  assert.equal(router.type, 'n8n-nodes-base.switch');
  assert.equal(router.typeVersion, 3.4);
  assert.equal(router.parameters.mode, 'expression');
  assert.equal(router.parameters.numberOutputs, 3);
  assert.match(router.parameters.output, /KSEF_MANUAL_SWEEP_MODE/);
  assert.deepEqual(outputTargets(router.name), [
    ['Get Durable Entry Lifecycle Guard'],
    ['Get Durable Recovery Lifecycle Rows'],
    ['Build Intake Persist Fixtures'],
  ]);

  assert.equal(evaluateRouter('submission'), 0);
  assert.equal(evaluateRouter('recovery'), 1);
  assert.equal(evaluateRouter('intake_fixture'), 2);
  assert.equal(evaluateRouter(' RECOVERY '), 1);
  assert.equal(evaluateRouter('unknown'), 0);
  assert.equal(evaluateRouter(undefined, false), 0);

  assert.deepEqual(outputTargets('Durable Recovery Schedule'), [['Get Durable Recovery Lifecycle Rows']]);
  for (const retiredName of [
    'Durable Submission Topology Sweep',
    'Durable Recovery Sweep',
    'Intake Persist Fixture Sweep',
  ]) {
    assert.equal(workflow.nodes.some((node) => node.name === retiredName), false, `${retiredName} node must be removed`);
    assert.equal(Object.hasOwn(workflow.connections, retiredName), false, `${retiredName} connection must be removed`);
  }
});

test('every KSeF functional node is trigger-reachable while the template remains inert', () => {
  const triggerTypes = new Set([
    'n8n-nodes-base.manualTrigger',
    'n8n-nodes-base.scheduleTrigger',
    'n8n-nodes-base.webhook',
  ]);
  const queue = workflow.nodes
    .filter((node) => triggerTypes.has(node.type))
    .map((node) => node.name);
  const reachable = new Set(queue);

  while (queue.length) {
    const current = queue.shift();
    for (const edges of outgoing(current)) {
      for (const edge of edges ?? []) {
        if (reachable.has(edge.node)) continue;
        reachable.add(edge.node);
        queue.push(edge.node);
      }
    }
  }

  const functionalNames = workflow.nodes
    .filter((node) => node.type !== 'n8n-nodes-base.stickyNote')
    .map((node) => node.name);
  assert.deepEqual(functionalNames.filter((name) => !reachable.has(name)), []);

  assert.equal(workflow.activeVersionId, null);
  assert.equal(workflow.activeVersion, null);
  assert.equal(workflow.settings.availableInMCP, false);
  assert.equal(workflow.nodes.some((node) => node.credentials !== undefined), false);
  assert.equal(workflow.pinData, undefined);
});

test('recovery alert failure stops before the only throttle-recording path', () => {
  const alert = workflow.nodes.find((node) => node.name === 'Send Controlled Recovery Alert');
  assert.ok(alert, 'recovery Gmail node must exist');
  assert.equal(Object.hasOwn(alert, 'onError'), false);
  assert.equal(alert.retryOnFail, true);
  assert.equal(alert.maxTries, 2);
  assert.deepEqual(outputTargets(alert.name), [['Record Recovery Alert Throttle']]);
  assert.deepEqual(incomingSources('Record Recovery Alert Throttle'), [alert.name]);
});

test('submission is reachable only after the fail-stop durable intent insert', () => {
  for (const [label, graph] of [['canonical', workflow], ['annotated derivative', annotated]]) {
    const intentInsert = graph.nodes.find((node) => node.name === 'Insert Durable Entry State Rows');
    assert.ok(intentInsert, `${label}: durable intent insert must exist`);
    assert.equal(Object.hasOwn(intentInsert, 'onError'), false, `${label}: intent insert must use default stop-on-error behavior`);
    assert.equal(Object.hasOwn(intentInsert, 'alwaysOutputData'), false, `${label}: intent insert must not emit data after an empty or failed insert`);
    assert.deepEqual(
      outputTargets(intentInsert.name, graph),
      [['Run Mock Submit After Durable Intent']],
      `${label}: successful intent persistence must continue to the submit adapter`,
    );
    assert.deepEqual(
      incomingSources('Run Mock Submit After Durable Intent', graph),
      [intentInsert.name],
      `${label}: every submit path must pass through the fail-stop intent insert`,
    );
  }
});

test('the rebuilt KSeF Creator derivative passes the canonical annotation validator', () => {
  assert.doesNotThrow(() => validate(SLUG, workflow, annotated));
});
