import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { WORKFLOWS, validate, verifyAcceptedArtifactPin } from '../scripts/creators-annotations.mjs';

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

test('Creator annotation specs enforce balanced grouping for every workflow', () => {
  for (const [slug, spec] of Object.entries(WORKFLOWS)) {
    const source = load(slug, 'workflow.json');
    const functionalCount = source.nodes.filter((node) => node.type !== 'n8n-nodes-base.stickyNote').length;
    const minimumSections = Math.ceil(functionalCount / 8);
    const maximumSections = Math.floor(functionalCount / 5);
    const microSections = spec.sections.filter((section) => section.nodes.length <= 2);

    assert.ok(spec.sections.length >= minimumSections, `${slug}: too few narrative sections`);
    assert.ok(spec.sections.length <= maximumSections, `${slug}: too many fragmented sections`);
    assert.ok(microSections.length <= 1, `${slug}: repeated one/two-node sections`);
    assert.ok(spec.sections.every((section) => section.nodes.length <= 11), `${slug}: oversized catch-all section`);
  }
});

test('Creator annotation validation rejects a grouping average below five nodes', () => {
  const slug = '06-bank-reconciliation';
  const source = load(slug, 'workflow.json');
  const artifact = load(slug, 'workflow-annotated-v2.json');
  const originalSections = WORKFLOWS[slug].sections;
  const fragmentedSections = originalSections.flatMap((section, index) => {
    if (index > 1) return [section];
    const splitAt = Math.ceil(section.nodes.length / 2);
    return [
      { ...section, title: `${section.title} A`, nodes: section.nodes.slice(0, splitAt) },
      { ...section, title: `${section.title} B`, nodes: section.nodes.slice(splitAt) },
    ];
  });

  assert.equal(fragmentedSections.length, 13);
  try {
    WORKFLOWS[slug].sections = fragmentedSections;
    assert.throws(
      () => validate(slug, source, artifact),
      /balanced grouping has 13 sections, expected 8-12/,
    );
  } finally {
    WORKFLOWS[slug].sections = originalSections;
  }
});

test('Only unchanged accepted artifacts may retain the legacy 144px top padding', () => {
  const legacySpecs = Object.entries(WORKFLOWS)
    .filter(([, spec]) => spec.acceptedLegacyLayout)
    .sort(([left], [right]) => left.localeCompare(right));

  assert.deepEqual(
    Object.fromEntries(legacySpecs.map(([slug, spec]) => [slug, spec.acceptedArtifactSha256])),
    {
      '02-invoice-dunning': 'd3d2d6df1ae3eb28ad48d7a8b28013af7dc1e7800339a10ab9b75a566b40e754',
      '04-support-triage': '74ca9414dc93468bc128eb156312c22551b5ff5c0d98f415935fd730a1866225',
    },
  );
  for (const [slug, spec] of legacySpecs) {
    assert.match(spec.acceptedArtifactSha256, /^[a-f0-9]{64}$/, `${slug}: legacy allowance must have a SHA-256 pin`);
    const rawArtifact = readFileSync(resolve(ROOT, 'workflows', slug, 'workflow-annotated-v2.json'));
    assert.doesNotThrow(() => verifyAcceptedArtifactPin(slug, rawArtifact));
  }
  for (const slug of ['07-ksef-exception-desk', '08-client-onboarding-saga']) {
    assert.equal(WORKFLOWS[slug].sectionTopPadding, undefined, `${slug}: unsubmitted artifact must use the 192px default`);
  }
});

test('Legacy layout allowance fails closed without its byte pin', () => {
  const slug = '02-invoice-dunning';
  const rawArtifact = readFileSync(resolve(ROOT, 'workflows', slug, 'workflow-annotated-v2.json'));

  assert.throws(
    () => verifyAcceptedArtifactPin(slug, rawArtifact, { acceptedLegacyLayout: true }),
    /accepted legacy layout requires an acceptedArtifactSha256 pin/,
  );
  assert.throws(
    () => verifyAcceptedArtifactPin(slug, Buffer.concat([rawArtifact, Buffer.from(' ')])),
    /does not match pinned/,
  );
});
