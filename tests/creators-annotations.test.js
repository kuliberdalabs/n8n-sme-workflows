import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { validate } from '../scripts/creators-annotations.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function load(slug, filename) {
  return JSON.parse(readFileSync(resolve(ROOT, 'workflows', slug, filename), 'utf8'));
}

test('Creator annotation validation rejects grid-aligned drift from the declared map', () => {
  const slug = '05-ops-digest-alert';
  const source = load(slug, 'workflow.json');
  const artifact = load(slug, 'workflow-annotated-v2.json');
  const shifted = structuredClone(artifact);
  const node = shifted.nodes.find((candidate) => candidate.name === 'Morning Digest Schedule');
  node.position[0] += 16;

  assert.throws(
    () => validate(slug, source, shifted),
    /Morning Digest Schedule: position differs from declared section placement/,
  );
});

test('Creator annotation validation rejects loss of the corrected top text clearance', () => {
  const slug = '05-ops-digest-alert';
  const source = load(slug, 'workflow.json');
  const artifact = load(slug, 'workflow-annotated-v2.json');
  const compressed = structuredClone(artifact);
  const node = compressed.nodes.find((candidate) => candidate.name === 'Morning Digest Schedule');
  node.position[1] = 144;

  assert.throws(
    () => validate(slug, source, compressed),
    /top text safety padding is 144, expected at least 192/,
  );
});

test('Creator annotation validation rejects an unsafe narrow section', () => {
  const slug = '05-ops-digest-alert';
  const source = load(slug, 'workflow.json');
  const artifact = load(slug, 'workflow-annotated-v2.json');
  const narrowed = structuredClone(artifact);
  const section = narrowed.nodes.find((candidate) => candidate.name === 'Section 4 — Send the anomaly signal');
  section.parameters.width = 256;

  assert.throws(
    () => validate(slug, source, narrowed),
    /section 4: width is 256, expected at least 512/,
  );
});

test('Creator annotation validation rejects a connection corridor through an unrelated node', () => {
  const slug = '05-ops-digest-alert';
  const source = load(slug, 'workflow.json');
  const artifact = load(slug, 'workflow-annotated-v2.json');
  const obstructed = structuredClone(artifact);
  const noAlert = obstructed.nodes.find((candidate) => candidate.name === 'No Signal Alert');
  const signal = obstructed.nodes.find((candidate) => candidate.name === 'Signal Alert Needed?');
  noAlert.position = [signal.position[0] + 256, signal.position[1]];

  assert.throws(
    () => validate(slug, source, obstructed),
    /Signal Alert Needed\? -> Build Signal Alert Email: direct edge corridor crosses No Signal Alert/,
  );
});

test('Creator annotation validation rejects crossing non-adjacent connection corridors', () => {
  const slug = '05-ops-digest-alert';
  const source = load(slug, 'workflow.json');
  const artifact = load(slug, 'workflow-annotated-v2.json');
  const crossed = structuredClone(artifact);
  const positions = {
    'Morning Digest Schedule': [64, 144],
    'Fetch Sales Source': [320, 400],
    'Normalize Sales Source': [64, 400],
    'Fetch Support Source': [320, 144],
  };
  for (const [name, position] of Object.entries(positions)) {
    crossed.nodes.find((candidate) => candidate.name === name).position = position;
  }

  assert.throws(
    () => validate(slug, source, crossed),
    /Morning Digest Schedule -> Fetch Sales Source crosses Normalize Sales Source -> Fetch Support Source/,
  );
});
