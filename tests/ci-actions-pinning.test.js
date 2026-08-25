'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ciFile = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml');

test('official GitHub Actions dependencies are pinned to approved immutable SHAs', () => {
  const ciYaml = fs.readFileSync(ciFile, 'utf8');
  const actionUseLines = ciYaml
    .split('\n')
    .filter((line) => /\buses:\s*actions\//.test(line));

  assert.ok(actionUseLines.length > 0, 'CI must use at least one official GitHub Action');

  const actual = actionUseLines.map((line) => {
    const match = line.match(/^\s*-\s+uses:\s+(actions\/[a-z0-9._-]+)@([0-9a-f]{40})(?:\s+#.*)?\s*$/i);
    assert.ok(match, `official action must use a full 40-hex SHA: ${line.trim()}`);
    return [match[1], match[2]];
  });

  assert.deepEqual(actual, [
    ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
  ]);
});
