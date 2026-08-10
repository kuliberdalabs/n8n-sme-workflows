'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workflowRoot = path.resolve(
  process.env.WORKFLOW_ROOT || path.join(__dirname, '..', '..', 'workflows'),
);

function workflowFile(directory) {
  return path.join(workflowRoot, directory, 'workflow.json');
}

function loadWorkflow(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getCodeNode(file, exactName) {
  const workflow = loadWorkflow(file);
  const matches = workflow.nodes.filter((node) => node.name === exactName);
  assert.equal(matches.length, 1, `expected exactly one Code node named ${exactName} in ${file}`);
  assert.equal(matches[0].type, 'n8n-nodes-base.code', `${exactName} must be a Code node`);
  assert.equal(typeof matches[0].parameters?.jsCode, 'string', `${exactName} must contain jsCode`);
  return matches[0];
}

function items(rows) {
  return (rows || []).map((json) => ({ json }));
}

function executeCodeNode(file, exactName, options = {}) {
  const node = getCodeNode(file, exactName);
  const inputRows = options.inputRows || [options.input || {}];
  const nodeItems = options.nodeItems || {};
  const nodeOutputs = options.nodeOutputs || {};
  const sandbox = {
    require(specifier) {
      assert.equal(specifier, 'crypto', `unexpected require from ${exactName}`);
      return require('node:crypto');
    },
    $execution: { id: options.executionId || 'test-execution' },
    $input: {
      item: { json: inputRows[0] || {} },
      all: () => items(inputRows),
    },
    $items: (name) => items(nodeItems[name] || []),
    $: (name) => ({ item: { json: nodeOutputs[name] || {} } }),
    $vars: options.vars || {},
    $getWorkflowStaticData(scope) {
      assert.equal(scope, 'global', `unexpected workflow static-data scope from ${exactName}`);
      return options.workflowStaticData || {};
    },
  };
  vm.createContext(sandbox);
  const script = new vm.Script(`(function executeActualCodeNode() {\n${node.parameters.jsCode}\n})()`, {
    filename: `${path.basename(path.dirname(file))}:${exactName}`,
  });
  const result = script.runInContext(sandbox, { timeout: 1_000 });
  return JSON.parse(JSON.stringify(result));
}

module.exports = {
  executeCodeNode,
  loadWorkflow,
  workflowFile,
  workflowRoot,
};
