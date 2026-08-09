import { ThreadCategoryConfig } from '../models/thread-context';

// ─── Scope section ────────────────────────────────────────────────────────────

function buildIdentificationScopeSection(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  if (categoryConfigs.length === 0) {
    return `── SCOPE ──────────────────────────────────────────────────────────────────────

Map products from all categories.`;
  }

  const names = categoryConfigs.map((c) => `- ${c.categoryName}`).join('\n');
  return `── SCOPE ──────────────────────────────────────────────────────────────────────

This thread focuses on:
${names}`;
}

const IDENTIFICATION_EXAMPLE = {
  comments: [
    {
      commentId: 'c0',
      products: [{ type: 'explicit', linkLabel: 'A', contentQuality: 'high' }],
    },
    {
      commentId: 'c1',
      products: [{ type: 'referenced', linkLabel: 'A', contentQuality: 'low' }],
    },
    {
      commentId: 'c2',
      products: [
        {
          type: 'explicit',
          new: { brand: 'Gigabyte', model: 'M28U', categoryHint: 'monitor' },
          contentQuality: 'medium',
        },
      ],
    },
    { commentId: 'c3', products: [] },
  ],
};

// ─── Prompt body ──────────────────────────────────────────────────────────────

function buildCommentIdentificationPromptBody(): string {
  return `You map each Reddit comment to the products it references.

── INPUT ─────────────────────────────────────────────────────────────────────

- A list of RESOLVED products for this batch, each tagged with a letter
  (A, B, C, …) and shown with its real catalog name and specs. These are the
  products discovery already found and resolution already matched.
- The original post for context.
- A tree of comments. [PLAN] c0, c1, … need a result. [CONTEXT] nodes are shown
  only so you can resolve references — do NOT output results for them.

── TASK ────────────────────────────────────────────────────────────────────────

For every [PLAN] comment, list the products it references — 0, 1, or many:

  - The product is in the RESOLVED list → set \`linkLabel\` to its letter. Use the
    real specs shown there to disambiguate (e.g. "the 34-inch one" → the letter
    whose specs say 34"). This is the common case.
  - The comment names a product that is NOT in the resolved list (discovery
    missed it) → fill the \`new\` block with brand, model (or clues), and
    categoryHint. Use this sparingly — prefer a resolved letter whenever one
    fits.
  - The comment has no buyer-relevant product reference (a content-free
    reaction, a meta-reply, a question with no concrete product) → products: [].

Set \`type\` per product: "referenced" for a bare callback that adds no new
identification info ("I love mine", "same as yours"); "explicit" when the
comment names the product or adds a model/spec/disambiguating descriptor.

Set \`contentQuality\` for THIS comment and THIS product: high = substantive
evaluation; medium = verdict without depth; low = named but not evaluated.

Output one entry per [PLAN] comment using its exact short ID (c0, c1, …). Do NOT
invent products beyond the resolved list and explicit new mentions.

─────────────────────────────────────────────────────────────────────────────
EXAMPLE
─────────────────────────────────────────────────────────────────────────────

${JSON.stringify(IDENTIFICATION_EXAMPLE, null, 2)}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildCommentIdentificationSystemPrompt(
  categoryConfigs: ThreadCategoryConfig[],
): string {
  const body = buildCommentIdentificationPromptBody();
  const scope = buildIdentificationScopeSection(categoryConfigs);
  return `${body}

${scope}`;
}
