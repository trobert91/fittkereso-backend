# benchmark — Prompt-tuning harness for the thread extraction pipeline

`apps/benchmark` is a standalone Nx app that runs **one or more pipeline phases in isolation** against pluggable test inputs, with **multiple prompt candidates compared side-by-side**. It exists so prompt iteration doesn't require running the full Phase 0→7 pipeline against a real thread every time you want to test a one-line change in an extraction prompt.

This README is the spec. An LLM authoring a new scenario should be able to do so from this document alone, without reading the source.

---

## What the app does

Given a **scenario** (JSON), the harness:

1. Loads the input — either a real `Thread` from the DB (with comment-tree fetch from Reddit if stale) or a hand-built JSON fixture.
2. Builds the same `Subtree` + `ThreadContext` the production pipeline would build at that point.
3. For each **candidate** (system prompt + model combo) in the scenario, runs the phase **N times** in parallel (N is per-candidate, configurable).
4. Per run: assembles the prompts, calls `AiChatService.createChat` with the production schema, captures cost / usage / latency, classifies any failure (`providerError | emptyOrTruncated | notJsonParseable | schemaInvalid | deterministicCheckFail`).
5. Per candidate: runs deterministic guards (schema, `mustContain`, `mustNotContain`), aggregates cost/latency/reliability across the N runs, picks a representative run (median-cost successful run).
6. Optionally: invokes an **LLM judge** (separate model — Claude Haiku by default in seed scenarios) that scores all candidates against `expectations.desiredOutcome` with structured JSON output. Judge can also see an optional **golden output** (hand-curated reference) as guidance.
7. Builds a **Pareto comparison** — quality (judge score) × reliability (success rate) × cost (mean USD). A candidate is "dominated" iff another beats it on all three.
8. Writes `report.json` (machine-readable, stable schema) and `report.md` (side-by-side human-readable) under `apps/benchmark/runs/<timestamp>-<scenarioId>/`.

**Cost label convention:** every LLM call from the harness is tagged `benchmark:<scenarioId>:<candidateId>:<runIndex>` (candidates) or `benchmark:judge:<scenarioId>` (judge). This makes harness spend trivially separable from production via the MCP `get_cost_analysis` tool, and individual runs are addressable down to the single call.

**What the harness does NOT do:** it does not modify any production code path. It re-uses `PromptAssemblyService`, `SubtreeBuilderService`, `AiChatService`, `ThreadTreeService`, and the Zod/JSON schemas directly. The user prompt is **always** assembled by `PromptAssemblyService` — only the **system prompt** and the **model** can be varied per candidate. This guarantees benchmark results match production behavior.

---

## Currently supported phases

Milestone 1 ships only `identification` (Phase 1d in the production pipeline — products are extracted from PLAN comments via the LLM, schema: `subtree-identification.schema`). The runner contract is uniform — adding extraction/labeling/validation/op-summary/disambiguation is mostly a copy-paste of the identification runner with a different `PromptAssembly` method and schema.

Until those land, scenarios with `"phase": "extraction"` etc. **will fail at runtime** with `Phase "extraction" is not implemented yet`.

---

## Running the harness

The harness is invoked via Nx. Args after the target name are forwarded to the app.

```bash
# Run a single scenario, all candidates, scenario default N runs
npx nx run benchmark:run --scenario=monitors-identification-v1

# Override N runs (handy for cheap iteration on expensive scenarios)
npx nx run benchmark:run --scenario=monitors-identification-v1 --runs=1
npx nx run benchmark:run --scenario=monitors-identification-v1 --runs=10

# Whole suite (every *.scenario.json under apps/benchmark/scenarios/)
npx nx run benchmark:run --suite

# Filter to a phase across the whole suite
npx nx run benchmark:run --suite --phase=identification

# Skip the LLM judge (deterministic checks only — fast, no judge cost)
npx nx run benchmark:run --scenario=monitors-identification-v1 --no-judge

# Print the assembled prompts without calling any LLM (for prompt review)
npx nx run benchmark:run --scenario=monitors-identification-v1 --dry-run

# For real-thread inputs: never re-fetch from Reddit, fail if cached tree is missing/stale
npx nx run benchmark:run --scenario=ultrawide-real-thread-v1 --no-fetch
```

**Important:** use `--flag=value` form (not `--flag value`). Nx's argument forwarding is space-sensitive; the `=` form works reliably.

The npm shortcut:
```bash
npm run start:benchmark -- --scenario=monitors-identification-v1
```

### Output location

Each run writes to:

```
apps/benchmark/runs/<ISO-timestamp>-<scenarioId>/
├── report.json   # full structured record — stable schema, programmatically parseable
└── report.md     # side-by-side human-readable report
```

The `runs/` directory is gitignored.

---

## Authoring a scenario

A scenario is one JSON file. The harness auto-discovers any `**/*.scenario.json` under `apps/benchmark/scenarios/`. Filename convention: `<scenario-id>.scenario.json`.

The shape below is the **complete** authoring contract. All fields are described in dependency order — no forward references.

### Top-level shape

```jsonc
{
  "id":           "<string, must match the filename without .scenario.json>",
  "phase":        "identification",     // one of the supported phases (see above)
  "description":  "<one paragraph: what is being tested and why>",
  "runs":         { /* RunsConfig — see below */ },
  "input":        { /* RealThreadInput | FixtureInput — see below */ },
  "candidates":   [ /* CandidateSpec[] — at least one */ ],
  "expectations": { /* ExpectationsSpec — what good looks like */ },
  "judge":        { /* JudgeSpec — optional but strongly recommended */ }
}
```

### `runs` — N-run configuration

LLMs are noisy. A single sample is usually misleading. The harness runs each candidate `runs.perCandidate` times and aggregates statistics (min/mean/p95/max cost, success rate, score variance).

Subtrees, candidates, and runs all fan out in parallel via `Promise.all`. Throttling is done by a single global semaphore — the `LlmCallGate` — that caps **total simultaneous in-flight LLM calls** across the entire scenario (candidate runs + judge calls). That cap is `runs.maxInFlight` (default 4).

```jsonc
"runs": {
  "perCandidate": 5,        // required, positive integer. 1 disables variance reporting (use only for debugging).
  "maxInFlight":  4,        // optional, default 4. Global cap on simultaneous in-flight LLM calls.
  "stopOnSchemaErrorRate": 0.5  // optional, currently informational — will short-circuit a candidate when half its runs schema-fail (not yet enforced; future use).
}
```

**Picking N:**
- `perCandidate: 1` — cheap dry-iteration only. Cost stats degenerate (min=mean=max). Don't draw conclusions.
- `perCandidate: 3` — minimum for variance reporting. OK for early prompt-shape iteration.
- `perCandidate: 5` — recommended default. Decent variance signal at modest cost.
- `perCandidate: 10` — when comparing two prompts that look very close on N=5 and you need to decide whether the gap is real or noise.

**Picking `maxInFlight`:**
- `1` — strictly serial. Useful when debugging or when you want deterministic call-by-call log output.
- `4` (default) — modest parallelism, safe for any provider.
- `8`–`16` — recommended for big multi-subtree scenarios. Cuts wall-clock time roughly in proportion. Deepseek tolerates 10+ comfortably; OpenAI/Anthropic are more sensitive — watch for retried 429s in the log if you push higher.

The CLI `--runs=N` flag overrides `runs.perCandidate` for one invocation. The scenario file remains the canonical default.

> **Note:** The legacy `runs.concurrency` field has been replaced by `runs.maxInFlight`. Old scenarios still parse — `concurrency` is ignored at runtime with a deprecation warning logged at scenario load.

### `input` — where the test data comes from

Two kinds, mutually exclusive: `real-thread` (pulls a Thread from the DB) and `fixture` (loads hand-built JSON, no DB / Reddit). Both support **multiple subtrees per scenario** — the harness loops through every declared case, runs every candidate against each, and rolls the results into one report.

#### `kind: "real-thread"` — pull a real Thread from the DB

```jsonc
"input": {
  "kind":     "real-thread",
  "threadId": "636b1b30-d7da-4ddf-8504-a6957b64c789",  // UUID of an existing Thread row
  "mode":     "extraction",                            // "extraction" (NEW/IDENTIFIED → PLAN) | "validation" (EXTRACTED → PLAN)
  "subtrees": "all"                                    // sugar for "every subtree the SubtreeBuilder produces"
  //
  // OR an explicit list of cases:
  // "subtrees": [
  //   { "index": 0, "label": "OP" },
  //   { "index": 3,
  //     "label": "lg-vs-msi",
  //     "expectations": { /* per-subtree override — see Per-subtree overrides below */ },
  //     "judge": { "goldenOutput": { "path": "subtree-3.golden.json", "role": "reference" } }
  //   },
  //   { "index": 5 }
  // ]
  //
  // Legacy single-subtree shape (still supported, automatically normalized):
  // "subtreeIndex": 3
  //
  // "maxFetchAgeSec": 86400  // optional override of the 180-day staleness window
  //
  // Optional: per-scenario override of SubtreeBuilder packing knobs.
  // Any field omitted falls back to the benchmark defaults shown.
  // Use this to A/B builder behavior — e.g. "does maxPlanNodes=15 keep the
  // same quality as 10, with fewer subtrees and lower fixed overhead?"
  // "subtreeBuilder": {
  //   "softBudget":   6000,   // default
  //   "hardBudget":   10000,  // default
  //   "maxPlanNodes": 15,     // default (prod's processor.json uses 10)
  //   "maxDepth":     8       // default
  // }
}
```

What happens at runtime:
1. Loads the Thread with the same relations the review-collector uses (categories, comments, productReferences, resolvedModel, brand, productCategory).
2. Calls `ThreadTreeService.getOrCreateTree(thread)` — the same call site `ThreadProcessingListenerService` uses. If the cached `commentTree` is fresh (`< redditThreadExpiryInDays`, default 180), it's returned as-is. Otherwise it fetches from Reddit through the rate-limited queue and **persists the fresh tree to the DB**.
3. Builds `ThreadContext` with category configs loaded from `libs/config/src/lib/categories/<slug>/config.json`.
4. Calls `SubtreeBuilderService.buildSubtrees()` with default budgets (softBudget=6000, hardBudget=10000, maxPlanNodes=15, maxDepth=8) and the chosen `mode`. Override any of these per-scenario via `input.subtreeBuilder` (see commented block above).
5. For `"subtrees": "all"`: emits one case per built subtree. For an explicit list: looks each one up by index in the built map.

**Side-effect warning:** real-thread input **mutates the DB** if the tree is stale (this is intentional — matches prod). Pass `--no-fetch` on the CLI to short-circuit and fail rather than fetch when the cached tree is missing or stale.

**To find the right `threadId` and subtree indices:**
- Use the MCP tool `get_thread_simulation_data` with the threadId. It returns the same subtree map the harness will see, indexed identically. Subtree 0 is the OP subtree; 1..N are content subtrees.
- Useful for seeding scenarios from existing real data: thread `636b1b30-d7da-4ddf-8504-a6957b64c789` (the ultrawide-monitor thread) appears in `docs/thread-extraction/extraction-V1.json`.

**Cost considerations.** A scenario with `"subtrees": "all"` against a 9-subtree real thread, 2 candidates, `perCandidate: 5` runs 90 LLM calls + 9 judge calls. Order of $0.10–0.30 with cheap models. Use `--runs=1` while iterating, then bump back up.

#### `kind: "fixture"` — hand-built JSON, no DB or Reddit

```jsonc
"input": {
  "kind": "fixture",
  "path": "../../fixtures/identification/monitors-identification-tiny.fixture.json"  // path resolved relative to the scenario file
  //
  // Optional: explicit subtree case list (otherwise every subtree in the fixture file is used)
  // "subtrees": [
  //   { "index": 0, "label": "direct" },
  //   { "index": 1, "label": "anaphoric",
  //     "expectations": { /* per-subtree override */ }
  //   }
  // ]
}
```

This is the **CI / offline path**. No DB connection, no Reddit calls. Use when you want a deterministic, hermetic test of a specific prompt edge case (a comment that mentions a product dismissively, a node with deeply nested replies, multilingual text, etc.).

A fixture file can declare **one or more subtrees**. The harness can run a scenario against any subset:
- Omit `input.subtrees` → every subtree in the fixture is run (one case per fixture subtree).
- Set `input.subtrees: SubtreeCase[]` → only the listed indices run.

The fixture file shape (top-level keys):

```jsonc
{
  "thread": {
    "id":        "<string identifier — does not have to match a real DB row>",
    "title":     "<optional thread title>",
    "topic":     "<optional, e.g. r/ultrawidemasterrace>",
    "subreddit": "<optional, used as ThreadContext.subreddit if set, else falls back to topic>"
  },

  "categoryConfigs": [
    // Optional. Empty array = no category focus (the LLM gets a permissive prompt).
    // To test category-specific prompts, copy minimal fields from libs/config/src/lib/categories/<slug>/config.json
    {
      "categoryId":   "fixture-monitors",
      "categoryName": "Monitors",
      "confidence":   0.95,
      "promptConfig": {
        "validSpecs":              [ { "name": "refreshRate", "examples": "240Hz, 144Hz" } /* ... */ ],
        "productIdExamples":       [ { "mentioned": "MSI MPG 341CQPX", "brand": "MSI", "model": "MPG 341CQPX" } /* ... */ ],
        "technologyDescriptors":   ["OLED", "QD-OLED"],
        "specialInstructions":     "",
        "searchKeywordInstruction":"Include the model name and a differing spec value.",
        "productTypeWord":         "monitor"
      },
      "featureLabels": ["color accuracy", "HDR", "response time"],
      "featureConfigs":[],
      "useCaseConfigs":[]
    }
  ],

  // Optional. The OP summary that the production pipeline injects into the
  // user prompt as `## OP:` for non-OP subtrees. Lift verbatim from a logged
  // production prompt to make the benchmark prompt byte-identical to prod.
  // Omit (or leave as empty string) when intentionally testing without OP context.
  "opSummary": "@OP_Author: \"The author wants a 34\\\" 240Hz OLED ultrawide…\"",

  // Optional. Cheat sheet rendered under `## Products identified in this thread:`.
  // Same provenance as opSummary — copy from a logged production prompt. In
  // production this string GROWS subtree-by-subtree as products resolve, so a
  // single fixture-level value is just an approximation. Use the per-subtree
  // override (below) for byte-faithful replay across a multi-subtree thread.
  "cheatSheet": "── Monitors ──\nLG:\n  - LG 34GS95QE-B  [primary]\n…",

  // Multi-subtree fixture: declare an array.
  // Single-subtree fixture: declare `subtree: { ... }` instead (legacy form, still supported).
  "subtrees": [
    {
      "id":          "<arbitrary string id, unique within the fixture>",
      "isOpSubtree": false,           // true only for the synthetic OP subtree
      // Optional per-subtree cheat sheet override. When set, replaces the
      // fixture-level `cheatSheet` for THIS subtree only — needed because the
      // production cheat sheet evolves as products resolve. To replay byte-for-byte,
      // copy the cheat sheet text from each subtree's logged production prompt.
      "cheatSheet": "── Monitors ──\nLG:\n  - LG 34GS95QE-B  [primary]\nMsi:\n  - MSI MPG 341CQPX  [primary]",
      "nodes": [
        {
          "externalId":       "c_op",
          "authorId":         "t2_opauthor",        // optional
          "authorName":       "OP_GamerPC",         // optional
          "body":             "I'm torn between LG 34GS95QE-B and MSI MPG 341CQPX...",
          "nodeType":         "CONTEXT",            // PLAN | CONTEXT
          "depth":            0,                    // OP = 0, direct replies = 1, etc.
          "status":           "NEW",                // optional, default NEW. Other values: EXTRACTED, VALIDATED, etc. (CommentStatus enum)
          "parentExternalId": null                  // optional. omit or null for root.
        },
        {
          "externalId":       "c_reply1",
          "authorName":       "OledFan",
          "body":             "I own the MSI MPG 341CQPX and the colors are absolutely stunning.",
          "parentExternalId": "c_op",
          "nodeType":         "PLAN",
          "depth":            1
        }
        // …more nodes
      ]
    }
    // …more subtrees
  ]
}
```

**On `opSummary` and `cheatSheet` — staying faithful to production prompts:**

The production identification prompt is built by `PromptAssemblyService.buildIdentificationPrompt(subtree, context)`. It pulls three things from `ThreadContext`: `subreddit`, `opSection`, and `cheatSheetString`. The fixture's `categoryConfigs` covers `subreddit` and the system-prompt portion, but `opSection` and `cheatSheetString` only appear if the fixture provides `opSummary` and `cheatSheet`. Without them, the candidate sees a *narrower* prompt than production, and any model behavior driven by the cheat sheet (anaphoric resolution, variant disambiguation) is artificially harder to test.

The right way to populate them: pull the strings out of a real logged production prompt for the same thread. Each `Creating AI chat` debug log line for the identification step contains the full assembled `messages[1].content` — copy the section under `## OP:` into `opSummary`, and the section under `## Products identified in this thread:` into the corresponding subtree's `cheatSheet`. Each subtree had a different cheat sheet at run time (it grows as products resolve), so use the per-subtree override to keep the replay byte-faithful.

**Authoring rules for fixtures:**

- **`nodeType: "PLAN"`** marks comments the LLM should output identification entries for. Their position in `subtree.planNodes` determines short IDs `c0`, `c1`, `c2` in the prompt. The LLM must return one entry per PLAN node.
- **`nodeType: "CONTEXT"`** marks ancestor / sibling comments included in the prompt for context but not requiring output. Typically the OP and other already-processed comments.
- **`depth`** must be a non-negative number. The order of nodes in the array matters — the harness preserves array order when building the prompt (DFS-like).
- **`parentExternalId`** must reference an `externalId` that exists earlier in the same `nodes` array (or null for root). The harness wires up parent links in a second pass; forward references won't work.
- **`status`** maps to `CommentStatus` enum values. Most fixtures want `NEW` for PLAN nodes (so they're treated as un-processed) and any other value for CONTEXT nodes that are already in the DB.
- The fixture is materialized into in-memory `UserComment` instances with synthetic IDs `fixture-<externalId>`. None of it touches the real DB.

**When to use real-thread vs fixture:**
- **Real-thread** — when the thing you're testing depends on subtle real-world phrasing, depth, branching, author affinity, or media. The trade-off: requires a populated dev DB and possibly a Reddit fetch.
- **Fixture** — when you want to isolate **one specific behavior**: a dismissive product mention, a comment that mixes two products, a comment in another language, a deeply nested reply chain, a comment with code blocks. Easier to share, easier to reproduce, runs in CI.

### `candidates` — what's being compared

Each entry is a system-prompt + model combination. At least one is required. The N runs in `runs.perCandidate` are run for each candidate independently. Candidates and subtrees both fan out in parallel; total HTTP request rate is capped by the global `runs.maxInFlight` semaphore.

```jsonc
"candidates": [
  {
    "id":                 "baseline",
    "model":              "deepseek-v4-flash",   // any model id resolvable by AiProviderRegistry
    "systemPromptSource": "current",             // use the prod system prompt for this phase as-is
    "userPromptSource":   "current",             // optional, default "current". User prompt is ALWAYS production-assembled — this field is reserved for future overrides.
    "temperature":        1                      // optional. gpt-5* models force temperature=1 regardless.
    // "categoryConfigOverride": null            // optional, currently unused — reserved for swapping category configs per-candidate.
  },
  {
    "id":                 "stricter-rules-v1",
    "model":              "deepseek-v4-flash",
    "systemPromptSource": { "file": "candidates/identification/stricter-rules-v1.md" }
    //                     path is resolved relative to the scenario file. The file's contents
    //                     replace the production system prompt entirely.
  },
  {
    "id":                 "stricter-rules-on-mini",
    "model":              "gpt-5.4-mini",
    "systemPromptSource": { "file": "candidates/identification/stricter-rules-v1.md" }
  }
]
```

**Candidate authoring rules:**

- `id` must be unique within the scenario. It's used in cost labels (`benchmark:<scenarioId>:<id>:<runIndex>`), report sections, and judge JSON.
- `systemPromptSource: "current"` → uses the production system prompt for the phase. This is the **baseline** every other candidate is compared against. Always include exactly one candidate with `"current"` so you have a control.
- `systemPromptSource: { "file": "<relative-path>" }` → replaces the system prompt with the file contents. The file is plain text (markdown, plain prose, anything — it's used verbatim). Convention: store under `candidates/<phase>/<descriptive-name>.md` next to the scenario.
- `model` — must be a model id that `AiProviderRegistry.resolveChat` can resolve. Known prefixes: `gpt-` (OpenAI), `gemini-` (Gemini), `claude-` (Claude), `deepseek-` (DeepSeek), `openrouter:` (OpenRouter). Examples: `gpt-5.4-nano`, `gpt-5.4-mini`, `deepseek-v4-flash`, `claude-haiku-4-5-20251001`.
- `temperature` — default `1`. For `gpt-5*` models the harness forces `1` regardless of what you set (the underlying API rejects others).
- The **user prompt is never overridden** in M1 — it's always assembled by `PromptAssemblyService.buildIdentificationPrompt(subtree, context)`. This is intentional: keeps the deterministic context (PLAN/CONTEXT classification, author labels, cheat sheet, OP section, subreddit) identical to production. Only instruction text and model can vary.

**Choosing a candidate set:**

- A useful scenario has 2–4 candidates. More than 4 makes the report dense and inflates judge cost.
- Always include a `"baseline"` candidate using `systemPromptSource: "current"`. Without it you don't know whether your variant is better or just different.
- Useful axes to vary one at a time:
  - Same prompt, different models (cost vs quality trade-off).
  - Same model, different prompts (instruction-tuning).
  - Cross-product (same set of prompts on cheap + expensive model, to find Pareto front).

### `expectations` — what a good output looks like

This block is the contract — both prose and structured. It's what the deterministic checks evaluate per run AND what the judge reads as ground truth.

```jsonc
"expectations": {
  "desiredOutcome": "<one paragraph of prose: what a faithful output looks like, what to include, what to avoid, edge cases the model should handle correctly>",

  "schemaCheck": "subtree-identification.schema",   // optional, validates run.parsed against a Zod schema in libs/. Currently supported ids: "subtree-identification.schema".

  "mustContain": [
    // Each entry is a deterministic guard. ALL must pass per run for the run to be marked succeeded.
    { "kind": "productMention", "brand": "LG", "model": "34GS95QE-B" },
    { "kind": "substring",      "value": "QD-OLED",        "appliesTo": "stringifiedParsed" },
    { "kind": "regex",          "pattern": "240\\s*Hz",    "appliesTo": "rawContent" }
  ],

  "mustNotContain": [
    // Same shape as mustContain. ALL must NOT match.
    { "kind": "productMention", "brand": "Corsair", "model": "Xeneon 34WQHD240-C" }
  ]
}
```

**`desiredOutcome`** is the single most important field. It's prose, not code, and it's what the judge gets to read verbatim. Write it like a code review comment to a junior engineer who just produced the output: "I expected X, you should have done Y in this edge case, and Z is acceptable but suboptimal." The judge will use this to score; the human reading the report will use it to decide whether the judge's call is sane.

**`mustContain` / `mustNotContain` checks (`MustCheck`):**

| `kind` | shape | what it does |
| --- | --- | --- |
| `productMention` | `{ kind: "productMention", brand, model }` | Walks the parsed JSON and matches any nested object with `brand` + `model` fields equal (case-insensitive) to the values. Use this for "LG 34GS95QE-B must appear" or "Corsair Xeneon must not appear" — robust against schema-shape changes. |
| `regex` | `{ kind: "regex", pattern, appliesTo? }` | JS `RegExp` test (case-insensitive). `appliesTo` defaults to `stringifiedParsed` (the parsed JSON serialized via `JSON.stringify`); use `rawContent` to check the LLM's literal text response. |
| `substring` | `{ kind: "substring", value, appliesTo? }` | Case-insensitive `includes()`. Same `appliesTo` semantics. |

Pass-rates for `mustContain` and `mustNotContain` are aggregated across the N runs and shown in the Pareto table as `mustContain rate`. A rate < 100% means at least one run failed the guard.

**Authoring `productMention` checks — match the LLM's brand/model split, not yours.**

The check is a strict equality match on both `brand` and `model` fields (case-insensitive). For products with sub-brands or product-line names (think "Asus ROG Swift PG34WCDM", "LG UltraGear 34GS95QE", "Sony WH-1000XM5"), there's no canonical split — different LLMs structure the same product differently:

```jsonc
// Some candidates emit:
{ "brand": "ASUS", "model": "ROG Swift PG34WCDM" }
// Others emit:
{ "brand": "ROG", "model": "Swift PG34WCDM" }
// Or even:
{ "brand": "Asus", "model": "PG34WCDM", "specs": [{ "name": "productLine", "value": "ROG Swift" }] }
```

A `mustContain` check that matches one split won't match the others, even though the *information* is identical. **Don't guess the split — observe it.**

The right authoring workflow:
1. Write the scenario with `desiredOutcome` prose only (no `mustContain` for sub-branded products yet).
2. Run with `--no-judge --runs=1` against your baseline candidate.
3. Read the representative output in the report. See how the LLM split brand/model for that product.
4. Add the `mustContain` entry matching the observed split. If two candidates split it differently, pick the more common one and accept that the other will fail the check (which is real signal — they're producing different shapes for the same product, worth a judge rationale).

For products with no sub-brand ambiguity (`{ brand: "LG", model: "34GS95QE-B" }`), this is a non-issue — write the check upfront and move on.

**Heads-up:** the harness will tell you about a wrong split via the per-comment table — the candidate's output cell shows the actual brand/model the LLM emitted right next to the `deterministicCheckFail` row in the metrics table. If a check fails on a candidate whose output clearly contains the product, the check spec is wrong, not the candidate.

**When to use a deterministic guard vs `desiredOutcome` prose:**

- Use a guard when the property is **objectively checkable** ("LG must appear", "no Corsair", "specs array must be non-empty"). Guards are free, fast, and not subject to judge bias.
- Use `desiredOutcome` prose when the property is **judgment-y** ("calibrate contentQuality to match the dismissive tone", "prefer omission over low-quality entry"). The judge will read your prose and score on it.
- Don't duplicate. If `mustContain { brand: "LG", model: "34GS95QE-B" }` already enforces it, don't also write "must include LG 34GS95QE-B" in the prose — it's redundant.

**Do not** add a cost-ceiling guard. Cost is reported in the cost summary and shown in the Pareto table; comparing candidates on cost is the human's job at the end of the run.

### `judge` — LLM-as-judge scoring

Optional but strongly recommended. Without a judge, the report has only deterministic check pass-rates and cost — no quality dimension, so the Pareto table degenerates to "lowest-cost passing candidate wins."

```jsonc
"judge": {
  "enabled":      true,
  "model":        "claude-haiku-4-5-20251001",   // any AiProviderRegistry-resolvable model. Recommended: claude-haiku-4-5 for speed/cost, claude-sonnet-4-6 for harder calls.
  "instructions": "<scenario-specific scoring instructions, including the score keys you want and verdict format>",
  "perRun":       false,                          // false (default): one judge call sees the representative run + variance summary. true: judge scores every run individually.
  "goldenOutput": {                               // optional reference example
    "path": "monitors-identification-v1.golden.json",
    "role": "reference",                          // "reference" (one valid answer among many) | "ideal" (target ceiling, deviations are penalized)
    "note": "<context the judge should know about what's authoritative vs illustrative>"
  }
}
```

**`instructions` authoring template:**

```
Score each candidate on N dimensions, each 1-10:
(1) <dimension name> — <what to look for>
(2) <dimension name> — <what to look for>
(3) <dimension name> — <what to look for>
Return JSON {candidates:[{candidateId, scores:{<dim1>,<dim2>,<dim3>}, rationale}], verdict}.
Verdict format: 'best=<id>' | 'tie' | 'none-acceptable'.
```

The judge's response is parsed against a fixed JSON schema:
```jsonc
{
  candidates: [{ candidateId: string, scores: { [key: string]: number }, rationale: string }],
  verdict:    string                 // "best=<id>" | "tie" | "none-acceptable"
}
```

The `scores` keys are free-form (the judge structures them however your `instructions` tell it to). The Pareto picker computes each candidate's quality score as the **mean of all numeric values in `scores`** — so if you want one dimension to dominate, it's better to use one well-defined score than to fight the averaging.

**`perRun: false` (default)** — one judge call per scenario. The judge sees:
- scenario `description` and `expectations.desiredOutcome`
- the input subtree (rendered the same way `PromptAssemblyService.buildCommentsSection` renders it)
- for each candidate: the **representative run's parsed output** + a variance summary line (`"5 runs, schema 5/5, mustContain 4/5, cost $0.0042±$0.0009"`)
- the golden output (if any) under `## Reference output (hand-curated, role="<role>", treat as guidance, not as a hard target)`

Cheap, one call per scenario. Use this 95% of the time.

**`perRun: true`** — judge call per candidate-run. Yields per-candidate score distributions instead of one verdict. Use only when two candidates look very close on `perRun: false` and you need to be sure the gap is real.

**`goldenOutput`** — optional. A hand-curated example of what good looks like, stored as a JSON file next to the scenario. The harness:
1. Loads it from disk (path resolved relative to the scenario file).
2. Validates it against `expectations.schemaCheck` if set — a malformed golden aborts the run with an error.
3. Injects it into the judge prompt as `## Reference output (hand-curated, role="<role>", treat as guidance, not as a hard target)` with the canned instruction *"Use the reference to inform your faithfulness scoring; deviations are not automatically wrong, but you should explain them in your rationale."*

**`role: "reference"`** — one known-good answer among potentially many. Judge treats it as guidance.
**`role: "ideal"`** — the target ceiling. Judge penalizes candidates that fall noticeably short.

**Producing a golden:** run the scenario once with a baseline candidate, copy the representative run's parsed output from the report into a `*.golden.json` file, hand-edit obvious problems, and save a `note` explaining what's authoritative vs illustrative. Don't auto-generate goldens — that's grading homework with the answer key written by the student.

The golden is **not** used as a deterministic equality check — LLMs reorder fields, vary phrasing, give slightly different confidences. If you need exact-match enforcement on a specific field, encode it as `mustContain` / `mustNotContain` instead.

---

## Multi-subtree scenarios

A scenario can run against multiple subtrees in one shot. The harness loops the subtrees, runs every candidate against each, and produces **one report** with per-subtree sections + scenario-wide rollups. Same N-runs and same candidate set apply to every subtree.

**Why bother:** an extraction prompt that's right on the OP subtree but breaks on deep replies is invisible from a single-subtree scenario. Whole-thread coverage catches regressions you didn't think to write a fixture for.

### Two layers of expectations

Authors can write expectations at **scenario level** (default applied to every subtree) AND **per-subtree** (overrides the default for that one subtree). Per-subtree replaces (does not merge with) scenario-level — so if you set per-subtree `mustContain: [...]`, only those checks run for that subtree, not the union with scenario-level. The replace-not-merge rule keeps the behavior predictable.

Same rule for the LLM judge's `goldenOutput`: scenario-level golden is the default; per-subtree `judge.goldenOutput` overrides for that one subtree.

### Per-subtree case shape

```jsonc
{
  "index":        2,                    // required: subtree-map index for real-thread, or fixture.subtrees array index for fixture
  "label":        "lg-vs-msi",          // optional: stable label used in report sections, cost labels, judge log lines. Defaults to "subtree-<index>" or "OP" for index 0.
  "expectations": {                     // optional: per-subtree override of the scenario-level expectations block
    "desiredOutcome": "<override>",
    "mustContain":    [...],
    "mustNotContain": [...],
    "schemaCheck":    "subtree-identification.schema"
  },
  "judge": {                            // optional: per-subtree override of judge.goldenOutput
    "goldenOutput": {
      "path": "subtree-2.golden.json",
      "role": "reference"
    }
  }
}
```

### The `"all"` sugar

For real-thread inputs where you want to test every subtree the SubtreeBuilder produces, use `"subtrees": "all"`. The harness:
1. Loads the thread, builds the subtree map.
2. Emits one case per built subtree (label = `OP` for index 0, `subtree-1`, `subtree-2`, …).
3. Each case inherits the scenario-level `expectations` and `judge.goldenOutput`.

Use this when you have one good scenario-level desired outcome that should apply uniformly. Use the explicit list form when individual subtrees test different behaviors and need their own overrides.

For fixtures, `"subtrees": "all"` (or omitting `subtrees` entirely) runs every subtree the fixture file declares.

### Cost labels

Every LLM call from a multi-subtree scenario is tagged with the subtree dimension:

```
benchmark:<scenarioId>:<subtreeLabel>:<candidateId>:<runIndex>   # candidate runs
benchmark:judge:<scenarioId>:<subtreeLabel>                       # judge calls (one per subtree)
```

This makes `get_cost_analysis` queries drillable — you can find "how much did candidate X cost on subtree 3" with a wildcard match. The scenario-wide glob `benchmark:<scenarioId>:%` still matches everything (it just has more `:` segments now).

### What the judge sees

One judge call **per subtree**, not one per scenario. Each call sees that subtree's specific `desiredOutcome` (per-case override or scenario-level fallback) and its `goldenOutput`. The scenario-wide judge score is the mean of per-subtree judge means.

Stuffing 8 subtrees into one judge prompt would average away the interesting per-subtree signal and blow up the prompt size. The cost of N judge calls is the price of meaningful per-subtree feedback.

### What goes in the report

The report (`report.md`) for a multi-subtree scenario has:
1. Header with the scenario-level desired outcome and a list of subtree labels.
2. **One full section per subtree:** desired outcome (resolved), input subtree rendering, per-comment input → outputs table, per-subtree metrics table, judge verdict + rationales, representative outputs.
3. **Scenario-wide aggregates:** Pareto comparison, side-by-side metrics rolled up across subtrees, cost summary, cost-by-subtree table.

The per-comment table has **input on the left, candidates as columns**, with N runs stacked inside each candidate cell:

```
| input                          | `baseline`                    | `baseline-on-nano`            |
| ---                            | ---                            | ---                            |
| @user (depth 1, c0):<br>"..."  | run 0 ★ [...]<br>run 1 [...]<br>run 2 [...] | run 0 [...]<br>run 1 ★ [...]<br>run 2 [...] |
```

`★` flags the representative run for each candidate. Failed runs render their failure reason inline in italics so you see *which* of the N runs failed. With `perCandidate: 1` each cell holds a single `run 0 ★` line — same renderer, no special case.

### Worked example: thread-sweep scenario

`monitors-thread-sweep-v1.scenario.json` (in `scenarios/identification/`) demonstrates the full multi-subtree shape: 3 hand-built subtrees in a single fixture, each with its own per-subtree `expectations` block, plus scenario-level fallback and judge spec. Worth reading as a template.

---

## Scenario file layout

Recommended directory structure:

```
apps/benchmark/
├── scenarios/
│   └── <phase>/
│       ├── <scenario-id>.scenario.json
│       ├── <scenario-id>.golden.json          # optional, sits next to the scenario
│       └── candidates/
│           └── <candidate-id>.md              # plain-text prompt files referenced by candidates
├── fixtures/
│   └── <phase>/
│       └── <descriptive-name>.fixture.json    # shared fixtures, organized by phase
└── runs/                                       # gitignored — every run produces a timestamped subdir here
```

The **scenario id** must match the filename without `.scenario.json`. The harness uses the filename as the source of truth — the `id` field inside the file is informational.

A scenario can pass `--scenario=<id>` on the CLI by id alone; the harness walks `scenarios/` recursively and matches.

---

## The report

Each run writes a `runs/<timestamp>-<scenarioId>/` directory containing:

### `report.json` — stable, programmatically parseable shape

```jsonc
{
  "scenarioId": "monitors-thread-sweep-v1",
  "scenario":   { /* echo of the scenario file */ },

  // One entry per subtree the scenario tested. Length 1 for single-subtree scenarios.
  "subtrees": [
    {
      "subtreeCase": { /* ResolvedSubtreeCase: index, label, expectations, goldenOutput, … */ },
      "subtreeId":      "fixture-subtree-direct",
      "isOpSubtree":    false,
      "nodeCount":      3,
      "planNodeCount":  2,
      "renderedSubtree": "<exact comment section the LLM saw>",
      "planComments":   [{ "shortId": "c0", "authorName": "AcerOwner", "depth": 1, "body": "..." }],
      "candidates": [
        {
          "candidateId": "baseline",
          "model":       "deepseek-v4-flash",
          "runs":        [ /* CandidateRunResult[] — length = runs.perCandidate */ ],
          "cost":        { "total": 0.0017, "mean": 0.00083, "min": 0.00077, "max": 0.00088, "p95": 0.00088 },
          "latency":     { "meanSec": 20.6, "p95Sec": 23.8 },
          "usage":       { "meanPromptTokens": 2499, "meanCompletionTokens": 1717, "meanCachedTokens": 0 },
          "reliability": { /* totalRuns, successes, failures.byReason, detailsPerRun, successRate */ },
          "deterministicChecks": { "perRun": [], "aggregate": { "mustContainPassRate": 1.0, "mustNotContainPassRate": 1.0 } },
          "representativeRunIndex": 1
        }
        // …more candidates
      ],
      "judge": {
        "subtreeLabel": "direct",
        "candidates":   [{ "candidateId": "baseline", "scores": { "faithfulness": 9 }, "rationale": "..." }],
        "verdict":      "best=baseline",
        "cost":         0.0056,
        "model":        "claude-haiku-4-5-20251001",
        "rawContent":   "...",
        "parsed":       { /* same shape as candidates+verdict above */ }
      }
    }
    // …more subtree sections
  ],

  // Scenario-level rollups across all subtrees:
  "candidatesAggregate": [
    {
      "candidateId":         "baseline",
      "model":               "deepseek-v4-flash",
      "totalRuns":           9,                   // perCandidate × subtree count
      "successes":           9,
      "successRate":         1.0,
      "failuresByReason":    { /* counts across all subtrees */ },
      "cost":                { "total": 0.005, "mean": 0.00056, "p95": 0.00088 },
      "latencyMeanSec":      18.2,
      "judgeScore":          7.83,                // mean of per-subtree judge means
      "mustContainPassRate": 1.0,                 // weighted by run-count per subtree
      "mustNotContainPassRate": 1.0
    }
  ],
  "costSummary": {
    "scenarioId":  "monitors-thread-sweep-v1",
    "totalUsd":    0.0210,
    "byCandidate": { "baseline": { "runs": 9, "totalUsd": 0.005, "meanUsd": 0.00056, "p95Usd": 0.00088 } },
    "bySubtree":   { "direct": { "totalUsd": 0.0017, "byCandidate": { "baseline": 0.0017 } } },
    "judgeUsd":    0.0168,
    "byCostLabel": "benchmark:monitors-thread-sweep-v1:%"
  },
  "pareto": [
    { "candidateId": "baseline", "judgeScore": 7.83, "successRate": 1.0, "topFailureReason": null, "mustContainPassRate": 1.0, "meanCost": 0.00056, "dominatedBy": null, "paretoOptimal": true }
  ]
}
```

### Per-run shape (`CandidateRunResult`)

```jsonc
{
  "candidateId":         "baseline",
  "runIndex":            0,
  "model":               "deepseek-v4-flash",
  "systemPrompt":        "<full system prompt sent to the model>",
  "userPrompt":          "<full user prompt sent to the model>",
  "rawContent":          "<the model's raw response text>",
  "parsed":              { /* schema-validated JSON, undefined if validation failed */ },
  "schemaValid":         true,
  "schemaErrors":        [],
  "cost":                0.00088,
  "usage":               { "promptTokens": 2499, "completionTokens": 1915, "totalTokens": 4414, "cachedTokens": 0 },
  "executionTimeInSec":  23.8,
  "succeeded":           true,                          // false iff providerError | emptyOrTruncated | notJsonParseable | schemaInvalid | deterministicCheckFail
  "failureReason":       undefined,                     // RunFailureReason | undefined
  "failureMessage":      undefined
}
```

`failureReason` taxonomy:
| value | meaning | what to do |
| --- | --- | --- |
| `providerError` | 5xx, rate limit, timeout, model-side error | Retry, switch provider — not a prompt problem |
| `emptyOrTruncated` | `finishReason !== 'stop'` or empty content | Increase max-tokens, simplify the prompt |
| `notJsonParseable` | Schema set, output wasn't valid JSON | Tighten the "respond with JSON only" instruction |
| `schemaInvalid` | JSON parsed, but failed schema validation | Re-state the schema in the prompt; check enum casing |
| `deterministicCheckFail` | Schema passed, but `mustContain`/`mustNotContain` failed | Address the specific check (output is structurally fine but semantically off) |

### `report.md` — side-by-side human readable

Layout (top to bottom — aggregates come first so the headline lands at the top of the file):
1. **Header** — scenario id, phase, description, scenario-level desired outcome, list of subtree labels.
2. **Scenario-wide aggregates:**
   - Pareto comparison table (judge score = mean of per-subtree means)
   - rolled-up side-by-side metrics
   - cost summary + cost-by-subtree breakdown
3. **Per-subtree section** (one per subtree, in order):
   - resolved desired outcome (per-subtree override or scenario fallback)
   - input subtree rendered exactly as the LLM saw it
   - **per-comment outputs table** — input on the left, candidates as columns, N runs stacked inside each cell with `★` flagging the representative run
   - per-subtree metrics table (success rate, mustContain rate, judge score, cost, latency — one column per candidate)
   - judge verdict + per-dimension scores + rationales (when judge enabled)
   - representative outputs (full JSON dump per candidate)

---

## Worked example: a complete minimal scenario

A scenario testing whether the identification prompt correctly **omits** a dismissively-mentioned product.

**`apps/benchmark/scenarios/identification/headphones-dismissive-mention-v1.scenario.json`:**

```json
{
  "id": "headphones-dismissive-mention-v1",
  "phase": "identification",
  "description": "A reply commenter mentions Sennheiser HD 800S positively but also says 'never buy a Beyerdynamic DT 1990 again.' Tests whether the identification step correctly captures the Sennheiser as a positive reference and either omits or marks the Beyerdynamic as low-quality (since it's a negative anti-recommendation, not a buyer recommendation).",

  "runs": { "perCandidate": 3, "maxInFlight": 4 },

  "input": {
    "kind": "fixture",
    "path": "../../fixtures/identification/headphones-dismissive-mention.fixture.json"
  },

  "candidates": [
    { "id": "baseline", "model": "deepseek-v4-flash", "systemPromptSource": "current" },
    { "id": "baseline-on-nano", "model": "gpt-5.4-nano", "systemPromptSource": "current" }
  ],

  "expectations": {
    "desiredOutcome": "Identifies Sennheiser HD 800S with high contentQuality (it's a clear positive endorsement). Either omits the Beyerdynamic DT 1990 from the products list (preferred — it's an anti-recommendation, not a buyer-relevant mention) or marks it with low contentQuality. Schema-valid JSON. Every PLAN comment receives an entry, even if products is empty.",
    "schemaCheck": "subtree-identification.schema",
    "mustContain": [
      { "kind": "productMention", "brand": "Sennheiser", "model": "HD 800S" }
    ]
  },

  "judge": {
    "enabled": true,
    "model": "claude-haiku-4-5-20251001",
    "instructions": "Score each candidate on three dimensions, each 1-10: (1) faithfulness — did the candidate identify Sennheiser correctly without hallucinating other products? (2) calibration — did the Beyerdynamic mention end up correctly handled (omitted or low-quality)? (3) completeness — did every PLAN comment receive an entry? Return JSON {candidates:[{candidateId, scores:{faithfulness,calibration,completeness}, rationale}], verdict}. Verdict: 'best=<id>' | 'tie' | 'none-acceptable'.",
    "perRun": false
  }
}
```

**`apps/benchmark/fixtures/identification/headphones-dismissive-mention.fixture.json`:**

```json
{
  "thread": {
    "id": "fixture-headphones-dismissive",
    "title": "Best open-back for orchestral music?",
    "topic": "r/headphones",
    "subreddit": "r/headphones"
  },
  "categoryConfigs": [],
  "subtree": {
    "id": "fixture-headphones-subtree",
    "isOpSubtree": false,
    "nodes": [
      {
        "externalId": "c_op",
        "authorName": "ClassicalListener",
        "body": "Looking for an open-back under $1500 for orchestral music. Mostly classical and jazz. What would you recommend?",
        "nodeType": "CONTEXT",
        "depth": 0
      },
      {
        "externalId": "c_reply1",
        "authorName": "AudiophileVet",
        "body": "Sennheiser HD 800S is the obvious answer at that budget. Soundstage is unmatched for orchestral music — you can pinpoint every instrument. I've owned mine for 4 years and the comfort is great for long listening sessions. Just never buy a Beyerdynamic DT 1990 again — the treble fatigued me to tears within an hour, returned mine after a week.",
        "parentExternalId": "c_op",
        "nodeType": "PLAN",
        "depth": 1
      }
    ]
  }
}
```

Run it:
```bash
npx nx run benchmark:run --scenario=headphones-dismissive-mention-v1
```

The report will tell you which candidate handled the dismissive mention correctly.

---

## What an LLM agent should do when iterating

A typical iteration loop:

1. **Read the latest `report.json`** under `apps/benchmark/runs/`. Look at `pareto` → sort by `paretoOptimal: true`, then `judgeScore` desc.
2. **Identify the failure mode.** If `topFailureReason` is non-null, that points at a specific axis to fix:
   - `schemaInvalid` → reinforce the JSON shape in the system prompt.
   - `notJsonParseable` → add a "respond with JSON only, no prose around it" instruction.
   - `deterministicCheckFail` → look at `failureMessage` per run to see which check tripped.
   - judge score low → read the `rationale` for the candidate's lowest-scored dimension.
3. **Author a new candidate.** Save its system prompt as a new file under `candidates/<phase>/<descriptive-name>.md`. Add a candidate entry to the scenario:
   ```jsonc
   { "id": "stricter-rules-v2", "model": "<same model as the candidate it replaces>", "systemPromptSource": { "file": "candidates/identification/stricter-rules-v2.md" } }
   ```
4. **Re-run.** `npx nx run benchmark:run --scenario=<id>`.
5. **Compare.** The new run's report has both the old candidates (unchanged) and the new one. Did the new variant move up the Pareto front?
6. **Promote.** Once a variant clearly dominates the baseline, edit the production prompt file in `libs/thread-processor/src/lib/implementations/product-identity-first/prompts/<phase>.prompt.ts` to match. The next run with `systemPromptSource: "current"` will reflect the change.

**When in doubt, keep the baseline.** Variance numbers (`judgeScore.spread` if `perRun: true`, otherwise the cost min/max range) tell you if a difference is signal or noise. A 0.3-point judge gap on N=3 is probably noise; a 2-point gap is probably signal.

---

## Limits and known constraints

- **Phase support (M1):** identification only. Other phases parse but fail at runtime.
- **User prompt is fixed.** Always assembled by `PromptAssemblyService`. To test a different *user* prompt structure, edit the production assembly code — but then it'd be the production behavior, not a benchmark.
- **`categoryConfigOverride`** field exists in the schema but is currently unused. To swap category configs per-candidate, override them via the fixture's `categoryConfigs` array instead.
- **`runs.stopOnSchemaErrorRate`** is informational only — not yet enforced.
- **`maxFetchAgeSec`** on real-thread input is parsed but not yet wired through to `ThreadTreeService` (it always uses the default 180-day window).
- **Real-thread inputs mutate the DB** when the cached tree is missing or stale. Use `--no-fetch` to enforce read-only behavior in CI / branch reviews.
- **Suite mode (`--suite`)** runs scenarios sequentially and writes one report per scenario. There is no aggregate `suite-report.md` yet.
- **The judge model and its prompt** are not benchmarked themselves. If you change `judge.model` or `judge.instructions`, all candidate scores in the new run are not directly comparable to scores from previous runs.

---

## Reference: file paths the harness reads / writes

| Path | Role |
| --- | --- |
| `apps/benchmark/src/config/config.yaml` | App config (DB, AI provider keys, Reddit). Mirrors review-collector's. |
| `apps/benchmark/scenarios/**/*.scenario.json` | Scenario files. Auto-discovered. |
| `apps/benchmark/scenarios/**/*.golden.json` | Optional judge reference outputs. Resolved relative to the scenario. |
| `apps/benchmark/scenarios/**/candidates/*.md` | Per-candidate system prompt overrides. Resolved relative to the scenario. |
| `apps/benchmark/fixtures/<phase>/*.fixture.json` | Hand-built test inputs, organized by phase (`identification/`, `extraction/`, ...). Path is referenced by `input.path` in scenarios (relative to the scenario file). |
| `apps/benchmark/runs/<timestamp>-<scenarioId>/` | Per-run output. Gitignored. |
| `libs/thread-processor/src/lib/implementations/product-identity-first/prompts/*.prompt.ts` | Production prompt builders the baseline candidate uses. |
| `libs/thread-processor/src/lib/implementations/product-identity-first/schemas/*.schema.ts` | Production schemas referenced by `expectations.schemaCheck`. |
| `libs/config/src/lib/categories/<slug>/config.json` | Real category configs used for real-thread inputs (loaded by `CategoryConfigService`). |

The harness imports these as runtime dependencies — it does not duplicate or vendor them. If a production prompt or schema changes, the next benchmark run picks the change up automatically.
