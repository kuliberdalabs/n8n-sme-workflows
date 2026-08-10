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
- Leave at least 64 px side padding, 144 px title padding above nodes, and 80 px below nodes.
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

5. Import `workflow-annotated-v2.json` as a fresh, inactive workflow in n8n.
6. Inspect the full canvas and every section at readable zoom. Confirm that text, nodes, and connections are not obscured.
7. Export the freshly imported workflow and repeat the semantic comparison if n8n rewrites the JSON.
8. Submit only after operator approval. Never publish, email, commit, or push as an implicit part of annotation work.

## Static gate

The validator must prove all of the following before UI review:

- functional-node payloads are unchanged except for `position`;
- `connections` and behavior-affecting top-level state are unchanged;
- one yellow overview exists and contains 100–300 words;
- every section is white and contains only a title plus one sentence;
- the hand-authored section map covers every functional node exactly once;
- geometric containment also covers every functional node exactly once;
- section containers do not overlap;
- all positions and dimensions follow the 16 px grid;
- no two functional nodes share a position.

Passing the script is necessary, not sufficient. The final gate is always a fresh n8n import and human visual review.
