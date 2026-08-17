# Creator rejection audit — workflow 18148

## Scope

This audit covers only the n8n Creator Portal submission `18148`, titled “Send daily ops digests and age-based anomaly alerts with OpenAI and Gmail”. The portal artifact was audited separately from the repository's canonical workflow and corrected derivative.

## Exact rejected portal JSON

- Portal workflow ID: `8G7UFQiH9wkQ2Jw6`
- Portal version ID: `00b05ace-30e8-4361-817b-271d16b16760`
- SHA-256 of the JSON returned by `Template actions` → `Copy JSON`: `cea21d49aebe7e1c08f0afac8118be5813708f47dd24b0eafb1e460367f3d7b6`
- Shape: 28 nodes = 20 functional nodes + 8 sticky notes.
- State: inactive.

The rejected JSON was freshly imported into isolated n8n `2.34.5`, the latest stable release on the audit date. The first white note, `Sticky Note1`, was only `256 × 384` px. Its rendered heading and paragraph ended at canvas `y=144.3907`, while `When 8:30am Arrives` began at `y=144`. The text therefore overlapped the node by about `0.39` canvas px. Fit-to-canvas made the defect practically invisible; readable zoom and DOM geometry exposed it.

The other seven rejected stickies did not reproduce a text/node collision. Their rendered text ended at `y=72.39` or `y=96.39`, before the first node row at `y=144`.

## Separate source-integrity finding

The portal JSON was not the annotated derivative currently tracked in this repository:

- canonical behavior source `workflow.json`: 20 functional nodes, no stickies, SHA-256 `4a1964990e85f4b8c40ab473054ec1a5cd767c30a97b07e11b8cb443bd3ca030`;
- pre-fix local `workflow-annotated-v2.json`: 20 functional nodes + 5 stickies, SHA-256 `6639e98d16bc70d3e02b1606bc7635f48ceb8c7ef27f75bfe8f39e72472638b9`;
- rejected portal JSON: 20 functional nodes + 8 stickies, SHA-256 `cea21d49aebe7e1c08f0afac8118be5813708f47dd24b0eafb1e460367f3d7b6`.

The portal copy used older node names such as `When 8:30am Arrives`, `Compile Digest Inputs`, `Generate Digest Summary`, and `Limit Alert Anomalies`. The canonical source uses `Morning Digest Schedule`, `Aggregate Digest Inputs`, `Draft Ambient Summary`, and `Throttle Alert Anomalies`. The topology remained broadly similar, but node IDs and behavior payloads differed. This is source drift, not a layout-only delta. The corrected resubmission must therefore be rebuilt from canonical `workflow.json`, never by moving nodes inside the rejected portal JSON.

## Difference from the previous invoice-workflow correction

The prior workflow `02-invoice-dunning` had a structural canvas problem: dense multi-branch payment logic, edge crossings, and insufficient vertical separation. Its correction enlarged several section containers, moved later sections down to `y=3712`, and manually separated the payment branches.

Workflow `18148` has a much smaller direct visual defect: one narrow note wraps one line too far and crosses the first node row by about `0.39` px. The shared process failure was treating a passing static checker and fit-to-canvas screenshots as proof of current-renderer readability. The additional failure in `18148` was submitting a stale behavior artifact instead of the repository's canonical derivative.

## Root cause and prevention

1. The rejected artifact used eight compact notes, including an unsafe 256 px-wide section.
2. The first node row used the legacy `144` px top offset, but the current renderer placed the text bottom at `144.3907`.
3. Static geometry validated sticky and node rectangles, not the browser-rendered text box.
4. Previous QA evidence used broad full-canvas views; file names implying “section readable” did not prove that each section was inspected closely.
5. No portal-copy hash and behavior comparison caught that a stale JSON had been submitted.

The corrected contract now requires at least 512 px section width, a 192 px first-row offset for this reviewer-corrected artifact, at least 48 px between actual rendered text and the first node row, a fresh import into the latest stable n8n, and a recorded portal-versus-canonical comparison before resubmission.

## Acceptance evidence

- corrected JSON SHA-256: `cb42438d90741197f89e58df01563c1975b3acf9a148247640f4109274920be3`;
- shape: 25 nodes = 20 functional nodes + 5 sticky notes;
- canonical functional payload unchanged except for position: pass;
- connections and behavior-affecting top-level state unchanged: pass;
- repository-wide static validation: 7 configured artifacts passed;
- regression tests: 5 passed, including explicit top-clearance and minimum-width failures;
- fresh import and export: pass in isolated n8n `2.34.5`;
- round-trip note: n8n regenerated node IDs, added transient webhook IDs, and omitted explicit default parameter values; node names and connections remained intact. The repository artifact remains the delivery file because its validator proves exact canonical behavior preservation;
- overview rendered content bottom: `602.64` inside an `896` px sticky;
- all four section rendered content bottoms: `72.39`;
- all four first node rows: `192.00`;
- minimum measured rendered text-to-node clearance: `119.61` px;
- full-canvas and readable-renderer review: pass; all final lines visible, no sticky/sticky, sticky/node, node/node, or direct-edge-corridor collision found.
