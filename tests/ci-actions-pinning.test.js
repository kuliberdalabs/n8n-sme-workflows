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
    ['actions/checkout', '11d5960a326750d5838078e36cf38b85af677262'],
    ['actions/setup-node', '49933ea5288caeca8642d1e84afbd3f7d6820020'],
  ]);
});
