#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICKY_TYPE = 'n8n-nodes-base.stickyNote';
const NODE_SIZE = 96;
const DEFAULT_OVERVIEW_SIZE = { width: 896, height: 896 };
const DEFAULT_SECTION_BOTTOM_PADDING = 128;

const WORKFLOWS = {
  '02-invoice-dunning': {
    overviewSize: DEFAULT_OVERVIEW_SIZE,
    sectionBottomPadding: DEFAULT_SECTION_BOTTOM_PADDING,
    overviewTitle: 'Send invoices and chase overdue payments',
    overview: `## Send invoices and chase overdue payments

### How it works
1. Receives job-completion events, validates the token, and stores malformed inputs as dead letters.
2. Prices completed work from a fixed price book, creates a deterministic invoice key, and persists the invoice before sending email.
3. Receives payment events, deduplicates them, and marks matched invoices paid before later reminder updates can overwrite them.
4. Runs daily reminder and escalation sweeps with a fresh status recheck immediately before each controlled email.
5. Queues unmatched payments for human review and stops after the configured reminder or escalation threshold.

### Setup steps
- [ ] Create the required n8n Data Tables and re-select them in every Data Table node.
- [ ] Connect Gmail OAuth and replace \`ops@example.com\` in every Gmail node.
- [ ] Set \`DUNNING_WEBHOOK_TOKEN\` and send it in the documented request header.
- [ ] Configure the price book, VAT, currency, reminder timing, and escalation thresholds.
- [ ] Test completion, duplicate, invalid, payment, and sweep paths while the workflow is inactive.

### Customization
Adjust service prices, payment matching, reminder cadence, escalation rules, and the controlled operator inbox to match your invoicing process.`,
    sections: [
      section('Receive completion event', 'Validates the completion webhook, normalizes the job, handles ignored events, and claims the side effect.', 0, 0, 8, [
        'Job Completion Webhook', 'Validate Completion Token', 'Completion Authorized?', 'Respond Completion Unauthorized',
        'Normalize Completion Event', 'Completion Event Ignored?', 'Respond Completion Ignored', 'Claim Completion Side Effect',
      ]),
      section('Deduplicate completion', 'Reuses an existing invoice result and prevents replayed completion events from creating another invoice.', 2368, 0, 5, [
        'Completion Claim Duplicate?', 'Find Claimed Completion Row', 'Find Existing Invoice Row', 'Persistent Invoice Duplicate?', 'Respond Invoice Duplicate',
      ]),
      section('Persist invoice outcome', 'Stores invalid jobs as dead letters or persists, emails, and confirms a newly created invoice.', 3968, 0, 5, [
        'Completion Invalid?', 'Insert Completion Dead Letter', 'Mark Completion Claim Dead Letter', 'Respond Completion Dead Letter',
        'Insert Invoice Pending Email', 'Send Controlled Invoice Email', 'Build Invoice Email Update', 'Update Invoice Email Sent',
        'Mark Invoice Claim Sent', 'Respond Invoice Sent',
      ]),
      section('Receive payment event', 'Authenticates and validates payment callbacks before claiming a valid event for processing.', 0, 640, 8, [
        'Payment Webhook', 'Validate Payment Token', 'Payment Authorized?', 'Respond Payment Unauthorized',
        'Normalize Payment Event', 'Payment Invalid?', 'Respond Payment Dead Letter', 'Claim Payment Event',
      ]),
      section('Match payment safely', 'Separates duplicate, unmatched, already-paid, and newly payable invoices without guessing.', 2368, 640, 5, [
        'Payment Claim Duplicate?', 'Find Duplicate Payment Invoice Row', 'Duplicate Payment Invoice Missing?',
        'Find New Payment Invoice Row', 'New Payment Invoice Missing?', 'Find Unmatched Payment Queue Row',
        'Unmatched Payment Already Queued?', 'Respond Payment Unmatched', 'Respond Payment Duplicate', 'Payment Already Paid?',
      ]),
      section('Persist payment outcome', 'Queues unmatched payments once or atomically marks the matched invoice paid and returns its result.', 3968, 640, 6, [
        'Build Unmatched Payment Queue Row', 'Insert Unmatched Payment Queue Row', 'Build Paid Update',
        'Update Invoice Paid', 'Mark Payment Claim Paid', 'Respond Payment Marked Paid',
      ]),
      section('Claim due reminders', 'Selects due invoices, claims each reminder, and rechecks current status before any email.', 0, 1280, 6, [
        'Daily Dunning Sweep', 'Find Invoice Sent Rows', 'Build Due Dunning Actions', 'Claim Dunning Action',
        'Find Dunning Recheck Row', 'Build Dunning Recheck Decision',
      ]),
      section('Send controlled reminder', 'Persists the pending claim, sends to the controlled inbox, and records confirmed delivery state.', 1856, 1280, 6, [
        'Build Dunning Pending Update', 'Update Dunning Pending Claim', 'Send Controlled Dunning Nudge',
        'Build Dunning Sent Update', 'Update Dunning Sent', 'Mark Dunning Claim Sent',
      ]),
      section('Claim due escalations', 'Selects stuck invoices, claims each escalation, and rechecks eligibility before alerting a human.', 3712, 1280, 6, [
        'Daily Dunning Escalation Sweep', 'Find Escalation Invoice Rows', 'Build Due Escalation Actions',
        'Claim Escalation Action', 'Find Escalation Recheck Row', 'Build Escalation Recheck Decision',
      ]),
      section('Escalate to operator', 'Persists the escalation claim, alerts the controlled inbox, and records the final escalated state.', 5568, 1280, 6, [
        'Build Escalation Pending Update', 'Update Escalation Pending', 'Send Controlled Escalation Alert',
        'Build Escalation Sent Update', 'Update Escalation Sent', 'Mark Dunning Claim Escalated',
      ]),
    ],
  },
  '04-support-triage': {
    // Preserve the already-published artifact. New templates use the safer defaults above.
    overviewSize: { width: 800, height: 640 },
    sectionBottomPadding: 64,
    overviewTitle: 'Triage support requests and draft grounded replies',
    overview: `## Triage support requests and draft grounded replies

### How it works
1. Receives a support request, validates a dedicated token, redacts sensitive patterns, and matches the question against a closed knowledge base.
2. Sends knowledge-base misses and failed model validations to a human instead of inventing an answer.
3. Uses OpenAI only for matched questions, then verifies the cited source, intent, confidence, and unsafe phrasing.
4. Stores every successful answer as a draft; only a separate, token-protected approval webhook can send a reviewed reply.
5. Retries unconfirmed operator alerts without making intake-generated drafts sendable.

### Setup steps
- [ ] Create and re-select the \`Support_Tickets\` and \`Support_KB_Learnings\` Data Tables.
- [ ] Set separate intake and approval tokens in n8n Variables.
- [ ] Connect Gmail and OpenAI credentials and replace \`ops@example.com\`.
- [ ] Replace the demo knowledge-base array with your reviewed entries.
- [ ] Test a miss, duplicate, injection-style message, approval, edit, and rejection while inactive.

### Customization
Adjust the knowledge base, match and confidence thresholds, validation denylist, learning-capture policy, and controlled test inbox before production use.`,
    sections: [
      section('Receive and deduplicate request', 'Authenticates intake, redacts and normalizes the question, and returns existing results for replays.', 0, 0, 6, [
        'Support Intake Webhook', 'Validate Support Intake Token', 'Support Intake Authorized?', 'Respond Support Intake Unauthorized',
        'Normalize Support Intake', 'Claim Support Ticket Key', 'Support Claim Duplicate?', 'Find Claimed Support Row',
        'Find Existing Support Row', 'Persistent Support Duplicate?', 'Respond Support Duplicate',
      ]),
      section('Ground and validate draft', 'Matches the closed knowledge base, drafts from retrieved content, and validates the model output.', 1856, 0, 5, [
        'Support KB Match?', 'Draft Grounded Reply', 'Validate Grounded Draft', 'Insert Support Draft State', 'Validated Draft Ready?',
      ]),
      section('Deliver draft alert', 'Notifies the operator about a valid draft and records confirmed review-alert delivery.', 3456, 0, 6, [
        'Build Draft Review Alert', 'Send Controlled Draft Review Alert', 'Build Draft Alert Update',
        'Update Draft Alert Sent', 'Mark Support Claim Draft', 'Respond Support Draft Ready',
      ]),
      section('Escalate unsafe request', 'Persists KB misses or failed drafts, alerts the operator, and returns an escalated result.', 5312, 0, 7, [
        'Insert Support Escalation', 'Build Escalation Review Alert', 'Send Controlled Escalation Alert',
        'Build Escalation Alert Update', 'Update Escalation Alert Sent', 'Mark Support Claim Escalated', 'Respond Support Escalated',
      ]),
      section('Receive approval decision', 'Authenticates and validates the separate human-review action before claiming it once.', 0, 640, 8, [
        'Support Approval Webhook', 'Validate Support Approval Token', 'Support Approval Authorized?',
        'Respond Support Approval Unauthorized', 'Normalize Support Approval', 'Approval Input Valid?',
        'Respond Approval Invalid', 'Claim Approval Action',
      ]),
      section('Load approvable ticket', 'Rejects duplicate or stale actions and decides whether the reviewed action may send a reply.', 2368, 640, 6, [
        'Approval Duplicate?', 'Respond Approval Duplicate', 'Find Review Ticket Row',
        'Ticket Approvable?', 'Respond Ticket Not Approvable', 'Approval Sends Reply?',
      ]),
      section('Record no-send decision', 'Persists reject or escalate decisions and responds without sending any customer message.', 4224, 640, 3, [
        'Build Approval Decision Update', 'Update Approval Decision', 'Respond Approval Decision Recorded',
      ]),
      section('Send approved reply', 'Marks the send pending, delivers the reviewed text, records success, and chooses learning capture.', 5312, 640, 7, [
        'Build Approval Pre-Send Update', 'Update Approval Pending Send', 'Build Controlled Reply Email',
        'Send Controlled Support Reply', 'Build Sent Update', 'Update Support Sent', 'Learning Capture Allowed?',
      ]),
      section('Finish approved action', 'Optionally stores the approved Q&A pair and returns the matching successful response.', 5312, 1024, 4, [
        'Build Learning Capture Row', 'Insert KB Learning', 'Respond Approval Sent With Learning', 'Respond Approval Sent No Learning',
      ]),
      section('Retry review alerts', 'Finds unconfirmed operator alerts, retries delivery, and updates only alert metadata.', 0, 1024, 6, [
        'Support Review Alert Reconciliation Sweep', 'Find Unsent Support Review Alerts', 'Build Unsent Support Review Alert',
        'Send Reconciled Support Review Alert', 'Build Reconciled Support Alert Update', 'Update Reconciled Support Alert Sent',
      ]),
    ],
  },
};

function section(title, description, x, y, columns, nodes) {
  return { title, description, x, y, columns, nodes };
}

function stableId(key) {
  const hex = createHash('sha256').update(`kuliberda-creators:${key}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function sourcePath(slug) {
  return resolve(ROOT, 'workflows', slug, 'workflow.json');
}

function outputPath(slug) {
  return resolve(ROOT, 'workflows', slug, 'workflow-annotated-v2.json');
}

function build(slug) {
  const spec = requireSpec(slug);
  const overviewSize = spec.overviewSize ?? DEFAULT_OVERVIEW_SIZE;
  const sectionBottomPadding = spec.sectionBottomPadding ?? DEFAULT_SECTION_BOTTOM_PADDING;
  const source = JSON.parse(readFileSync(sourcePath(slug), 'utf8'));
  const functional = source.nodes.filter((node) => node.type !== STICKY_TYPE);
  const byName = new Map(functional.map((node) => [node.name, node]));

  for (const [sectionIndex, group] of spec.sections.entries()) {
    group.nodes.forEach((name, nodeIndex) => {
      const node = byName.get(name);
      if (!node) throw new Error(`${slug}: section ${sectionIndex + 1} names missing node: ${name}`);
      const column = nodeIndex % group.columns;
      const row = Math.floor(nodeIndex / group.columns);
      node.position = [group.x + 64 + column * 256, group.y + 144 + row * 256];
    });
  }

  const overview = {
    id: stableId(`${slug}:overview`),
    name: `Overview — ${spec.overviewTitle}`,
    type: STICKY_TYPE,
    typeVersion: 1,
    position: [-overviewSize.width - 128, 0],
    parameters: { content: spec.overview, ...overviewSize },
  };

  const stickies = spec.sections.map((group, index) => {
    const rows = Math.ceil(group.nodes.length / group.columns);
    return {
      id: stableId(`${slug}:section:${index + 1}`),
      name: `Section ${index + 1} — ${group.title}`,
      type: STICKY_TYPE,
      typeVersion: 1,
      position: [group.x, group.y],
      parameters: {
        content: `## ${group.title}\n${group.description}`,
        width: group.columns * 256 + 256,
        height: rows * 256 + sectionBottomPadding,
        color: 7,
      },
    };
  });

  const artifact = { ...source, nodes: [overview, ...stickies, ...functional] };
  validate(slug, source, artifact);
  writeFileSync(outputPath(slug), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`BUILT ${slug}: ${outputPath(slug)}`);
}

function validate(slug, source, artifact) {
  const spec = requireSpec(slug);
  const overviewSize = spec.overviewSize ?? DEFAULT_OVERVIEW_SIZE;
  const sectionBottomPadding = spec.sectionBottomPadding ?? DEFAULT_SECTION_BOTTOM_PADDING;
  const sourceFunctional = source.nodes.filter((node) => node.type !== STICKY_TYPE);
  const artifactFunctional = artifact.nodes.filter((node) => node.type !== STICKY_TYPE);
  const stickies = artifact.nodes.filter((node) => node.type === STICKY_TYPE);
  const overview = stickies.filter((node) => node.parameters.color === undefined);
  const sections = stickies.filter((node) => node.parameters.color === 7);
  const errors = [];

  const normalized = (nodes) => nodes.map(({ position, ...node }) => node);
  if (JSON.stringify(normalized(sourceFunctional)) !== JSON.stringify(normalized(artifactFunctional))) {
    errors.push('functional node payload changed outside position');
  }
  if (JSON.stringify(source.connections) !== JSON.stringify(artifact.connections)) errors.push('connections changed');
  const sourceTop = { ...source }; delete sourceTop.nodes;
  const artifactTop = { ...artifact }; delete artifactTop.nodes;
  if (JSON.stringify(sourceTop) !== JSON.stringify(artifactTop)) errors.push('top-level workflow state changed');
  if (overview.length !== 1) errors.push(`expected one yellow overview, found ${overview.length}`);
  if (sections.length !== spec.sections.length) errors.push(`expected ${spec.sections.length} white sections, found ${sections.length}`);
  if (overview[0]?.parameters.width !== overviewSize.width || overview[0]?.parameters.height !== overviewSize.height) {
    errors.push(`overview must be ${overviewSize.width}x${overviewSize.height} for the current renderer`);
  }

  const words = overview[0]?.parameters.content.trim().split(/\s+/).length ?? 0;
  if (words < 100 || words > 300) errors.push(`overview word count ${words} is outside 100-300`);

  const expectedNames = spec.sections.flatMap((group) => group.nodes);
  const functionalNames = artifactFunctional.map((node) => node.name);
  if (new Set(expectedNames).size !== expectedNames.length) errors.push('manual section map contains duplicate node names');
  for (const name of functionalNames) {
    if (!expectedNames.includes(name)) errors.push(`functional node missing from manual section map: ${name}`);
  }
  for (const name of expectedNames) {
    if (!functionalNames.includes(name)) errors.push(`manual section map names unknown node: ${name}`);
  }

  const rect = (node) => ({
    x1: node.position[0], y1: node.position[1],
    x2: node.position[0] + (node.parameters.width ?? NODE_SIZE),
    y2: node.position[1] + (node.parameters.height ?? NODE_SIZE),
  });
  const contains = (outer, inner) => outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;
  const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

  for (const node of artifactFunctional) {
    const coverage = sections.filter((sticky) => contains(rect(sticky), rect(node))).length;
    if (coverage !== 1) errors.push(`${node.name}: geometry coverage is ${coverage}, expected 1`);
  }
  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      if (overlaps(rect(sections[i]), rect(sections[j]))) errors.push(`${sections[i].name} overlaps ${sections[j].name}`);
    }
  }

  const allNumbers = artifact.nodes.flatMap((node) => [
    ...node.position,
    ...(node.type === STICKY_TYPE ? [node.parameters.width, node.parameters.height] : []),
  ]);
  if (allNumbers.some((value) => value % 16 !== 0)) errors.push('positions or sticky dimensions are off the 16 px grid');
  const positions = artifactFunctional.map((node) => node.position.join(','));
  if (new Set(positions).size !== positions.length) errors.push('functional nodes share duplicate positions');
  for (const sticky of sections) {
    if (sticky.parameters.content.split('\n').length > 2) errors.push(`${sticky.name}: section copy exceeds title plus one sentence`);
    const coveredNodes = artifactFunctional.filter((node) => contains(rect(sticky), rect(node)));
    const deepestNodeBottom = Math.max(...coveredNodes.map((node) => rect(node).y2), sticky.position[1]);
    const actualBottomPadding = sticky.position[1] + sticky.parameters.height - deepestNodeBottom;
    if (actualBottomPadding < sectionBottomPadding) {
      errors.push(`${sticky.name}: bottom text safety padding is ${actualBottomPadding}, expected at least ${sectionBottomPadding}`);
    }
  }

  if (errors.length) throw new Error(`${slug} validation failed:\n- ${errors.join('\n- ')}`);
  console.log(`PASS ${slug}: ${artifactFunctional.length} functional nodes, ${sections.length} white sections, overview ${words} words`);
}

function check(slug) {
  const source = JSON.parse(readFileSync(sourcePath(slug), 'utf8'));
  const artifact = JSON.parse(readFileSync(outputPath(slug), 'utf8'));
  validate(slug, source, artifact);
}

function requireSpec(slug) {
  const spec = WORKFLOWS[slug];
  if (!spec) throw new Error(`Unknown workflow: ${slug}. Available: ${Object.keys(WORKFLOWS).join(', ')}`);
  return spec;
}

const [command, requested] = process.argv.slice(2);
const slugs = requested ? [requested] : Object.keys(WORKFLOWS);
if (!['build', 'check'].includes(command)) {
  console.error('Usage: node scripts/creators-annotations.mjs <build|check> [workflow-slug]');
  process.exit(2);
}
for (const slug of slugs) command === 'build' ? build(slug) : check(slug);
