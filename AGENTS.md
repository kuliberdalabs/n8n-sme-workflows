# AGENTS.md — n8n SME Workflows

This is the canonical, model-neutral operating contract for this repository.

The repository owns reusable n8n workflow behavior, documentation, and Creators
submission artifacts. It does not own live credentials, accounts, customer data,
or permission to activate or submit anything.

## Start and ownership

1. Read this file.
2. Select exactly one of the three task routes below.
3. Read that route's local sources in order.
4. Obey explicit task file ownership and preserve every unrelated or concurrent
   change.
5. Run only the local checks permitted by the selected route and task brief.
6. Put durable results in the route's durable home.

Every task has one primary owner. Scripts, tools, providers, models, templates,
and derivative artifacts are capabilities or outputs, never owners.

The current external task brief or orchestrator owns the active roster and task
assignment. The current task brief controls its bounded file ownership. Models
and providers are interchangeable and never own this repository, a workflow, or
a decision.

Do not copy mutable submission, review, runtime, or assignment status into this
file. When current state matters, source it from the relevant HANDOFF, direct
operator evidence, or a dated/current receipt. Artifact existence and an old
PASS never prove current approval or submission state.

## Route 1 — Creators annotation and submission

- Primary owner: the selected workflow's bounded Creators annotation/submission
  task. Repository-wide annotation rules remain owned by
  `CREATORS-SUBMISSION-GUIDE.md`.
- Read in order:
  1. this file;
  2. `CREATORS-SUBMISSION-GUIDE.md`;
  3. the selected workflow's `README.md`;
  4. the selected workflow's `workflow.json` behavior source;
  5. the task-specific submission document, when present;
  6. a dated/current receipt only when mutable review state is needed.
- Behavior rule: `workflow.json` is authoritative for behavior. Annotation must
  produce the non-overwriting derivative `workflow-annotated-v2.json`. The
  derivative must never replace or silently modify behavior truth.
- Allowed local writes/checks: task-owned annotation map/script and derivative
  edits may be made only when each file is explicitly owned by the task. Static
  build/check commands may run only within that ownership and local authority.
- Validation: a passing static check is necessary, not sufficient. Final
  validation is a fresh import into a new, isolated, inactive n8n workflow plus
  human full-canvas review at readable zoom. Import/review never implies
  approval to submit.
- Hard gate: obtain exact operator GO before submission, upload, publication,
  external send, email, commit, or push. Credentials, activation, live execution,
  or external side effects also require exact authority.
- Durable home: repository-wide annotation rules in
  `CREATORS-SUBMISSION-GUIDE.md`; task-owned maps/scripts in their existing local
  home; derivative beside the selected `workflow.json`; dated QA evidence in the
  task-designated receipt location.
- Missing/current-state handling: consult the current task evidence, relevant
  HANDOFF, operator evidence, or latest dated receipt. If submission or approval
  state is absent or conflicting, treat it as not submitted and park only the
  external action; continue safe local work.

## Route 2 — Workflow behavior and engineering

- Primary owner: the selected workflow's behavior/engineering task, rooted in
  its `workflow.json` and bounded supporting files.
- Read in order:
  1. this file;
  2. the selected workflow's `README.md`;
  3. its `workflow.json`;
  4. `SECURITY.md`;
  5. task-specific tests and local docs named by the brief or nearer sources.
- Behavior rule: `workflow.json` is the behavior source. An annotated export,
  screenshot, receipt, or README cannot replace it or establish behavior by
  itself.
- Allowed local writes/checks: bounded workflow, test, and documentation edits
  plus local/static tests are allowed only under explicit task file ownership.
  Use placeholder or synthetic data and preserve inactive defaults.
- Hard gate: exact authority is required before attaching or accessing
  credentials, activating a workflow, running it live, calling an API or webhook,
  sending email, causing any external side effect, or using real business data.
  Commit, push, publish, upload, and destructive actions are separately gated.
- Durable home: behavior in the selected `workflow.json`; workflow-specific
  operating truth in its `README.md`; reusable security policy in `SECURITY.md`;
  tests and evidence in their nearest task-owned repository location.
- Missing/current-state handling: if live, credential, environment, or test
  state is missing, do not infer or probe it. Treat the workflow as inactive and
  unauthorized for live use, record the unknown locally when the task owns a
  receipt, and continue independent static work.

## Route 3 — Documentation and local verification

- Primary owner: the bounded repository documentation or local-verification
  task and its explicitly named files.
- Read in order:
  1. this file;
  2. the nearest relevant repository README or guide;
  3. the artifact being documented or checked;
  4. task-specific check instructions and tests;
  5. a dated/current receipt only when a current-state claim is required.
- Allowed local writes/checks: bounded documentation edits and static,
  read-only, local checks within explicit task ownership. Verification may report
  evidence but must not run or activate a workflow merely to improve confidence.
- Hard gate: exact authority is required before publication, external send,
  email, commit, push, upload, live/runtime/account mutation, credential access,
  real-data use, money movement, or a destructive action.
- Durable home: stable guidance in the nearest repository docs; workflow-specific
  guidance beside that workflow; dated final-state evidence in the nearest
  task-owned receipt location designated by the task. Never duplicate durable
  learning in a global scratchpad.
- Missing/current-state handling: label unsupported current claims as unknown.
  Seek a relevant HANDOFF, direct operator evidence, or dated receipt only when
  the task needs that state. Park the unsupported claim or gated action and
  complete independent documentation/static verification.

## Common safety rules

- Resolve reversible ambiguity conservatively; stop only the affected gated
  action or genuine source collision.
- Never expose, copy, fabricate, or commit credentials, tokens, customer data,
  private business records, or real recipient addresses.
- Never interpret a local artifact, static PASS, screenshot, import, or human
  review as permission to commit, push, publish, upload, email, or submit.
- Security reports follow `SECURITY.md`; contacting the listed address is still
  an external send and requires the task's exact authority.
- Keep the repository clean: no unrelated rewrites, generated junk, status
  snapshots in canonical docs, or duplicated global memory.
