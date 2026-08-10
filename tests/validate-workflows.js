'use strict';

const fs = require('node:fs');
const path = require('node:path');

const workflowRoot = path.join(__dirname, '..', 'workflows');
const files = fs.readdirSync(workflowRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(workflowRoot, entry.name, 'workflow.json'))
  .filter((file) => fs.existsSync(file))
  .sort();

if (!files.length) throw new Error('no workflows/*/workflow.json files found');

for (const file of files) {
  JSON.parse(fs.readFileSync(file, 'utf8'));
}

console.log(`Parsed ${files.length} workflow JSON files.`);
