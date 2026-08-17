# n8n Creators submission guide

This is the repository-wide annotation contract for n8n Creators submissions. It is based on the version of workflow `17741` that n8n approved in August 2026.

## Visual contract

- Add exactly one default-yellow overview sticky in the upper-left, separate from the workflow graph.
- Keep the overview between 100 and 300 words. It must explain what the workflow does, how it works, the required setup, and useful customization points.
- Use white sticky notes (`color: 7`) as real background containers around logical sections whenever the workflow has more than four functional nodes.
- Give each section a short title and no more than one or two concise sentences.
- Every functional node must sit fully inside exactly one white section.
- Use a red sticky only for a genuinely crucial setup warning. Do not add decorative colors.
- Snap node and sticky positions and sticky dimensions to the 16 px grid.
- For every new or reviewer-corrected artifact, use a section width of at least 512 px, leave at least 64 px side padding, place the first node row at least 192 px below the sticky top, and leave at least 128 px below nodes. The older 144 px top offset is not safe: n8n 2.34.5 rendered a narrow section's last line through `y=144.39`.
- The generator defaults to the 192 px offset. Explicit 144 px overrides exist only so unchanged historical artifacts can still be checked; remove that compatibility override before correcting or resubmitting one of them.
- For a 180–200 word overview, use at least an `896 × 896` sticky. Treat this as a starting floor, not proof that the text fits.
- Section stickies must not overlap one another. Functional nodes must not share positions.

## Authoring rule

Do not run n8n workflow `13868` or another generic auto-annotator. A human must define the section map from the actual workflow behavior first. The local script only applies that explicit map, produces repeatable geometry, and validates the result; it must never infer sections from node positions or AI-generated labels.

For each new template:

1. Read its README and trace every connection branch.
2. Write the overview and the explicit list of nodes belonging to every logical section in `scripts/creators-annotations.mjs`.
3. Build the annotated copy without overwriting `workflow.json`:

   ```bash
   node scripts/creators-annotations.mjs build <workflow-slug>
   ```

4. Run the static gate:

   ```bash
   node scripts/creators-annotations.mjs check <workflow-slug>
   ```

5. Import `workflow-annotated-v2.json` as a fresh, inactive workflow in the latest released n8n version.
6. Use fit-to-canvas only for orientation. Then inspect the overview and every section at readable zoom. Confirm that every final line is visible, there is no scrollbar or clipped text, and text, nodes, and connections are not obscured.
7. Prove text clearance in the current renderer: the first node row must start at least 48 px below the actual rendered bottom of the section text. Record the n8n version and the smallest measured clearance. A full-canvas screenshot or a pass on an older n8n version is not sufficient.
8. Export the freshly imported workflow and repeat the semantic comparison if n8n rewrites the JSON.
9. Submit only after operator approval. Never publish, email, commit, or push as an implicit part of annotation work.

## Reviewer-requested resubmissions

For a template returned with requested changes, resubmit from the Creator dashboard via `Pending` → `Implement changes` → `Submit for human review`. Do not use the detail page's `Template actions` → `Upload new version` path for this state; it can fail with a generic upload error and does not complete the reviewer-feedback flow.

Before editing a returned template, use the detail page's `Copy JSON` action to capture the exact submitted artifact. Hash and audit that JSON separately, then compare its functional-node payload and connections with the repository's canonical `workflow.json`. Never assume the portal copy equals the newest local annotated file. Build the replacement from canonical behavior; do not preserve stale submitted logic merely to make its canvas look better.

## Static gate

The validator must prove all of the following before UI review:

- functional-node payloads are unchanged except for `position`;
- `connections` and behavior-affecting top-level state are unchanged;
- one yellow overview exists and contains 100–300 words;
- every section is white and contains only a title plus one sentence;
- the hand-authored section map covers every functional node exactly once;
- geometric containment also covers every functional node exactly once;
- section containers do not overlap;
- every section is at least 512 px wide and uses its declared top text-safety padding;
- all positions and dimensions follow the 16 px grid;
- no two functional nodes share a position.

Passing the script is necessary, not sufficient. The final gate is always a fresh n8n import and human visual review.
