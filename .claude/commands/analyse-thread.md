# Thread Extraction Analysis

Perform a comprehensive quality analysis of the extraction pipeline results for thread `$ARGUMENTS`.

`$ARGUMENTS` may be one of:

- A thread ID (UUID or short prefix) — use MCP-based data collection (default mode).
- A path or filename of a local JSON file under `docs/thread-extraction/` (e.g. `736.json`, `docs/thread-extraction/736.json`, or just `736`) — use **local file mode**: read extracted comments and product references from the file instead of calling MCP. In this mode, the thread ID is taken from `items[0].thread.id` inside the JSON. Optional MCP contexts (Steps 1, 8) are skipped unless the user explicitly asks for them.

Detect local file mode if `$ARGUMENTS` matches a file under `docs/thread-extraction/` (with or without `.json`).

## Data Collection Steps

Execute the following steps to gather data. Work through them sequentially where results inform subsequent calls.

### Step 1 — Thread Overview

**Local file mode:** Read the JSON file once and use `items[0].thread` for title, topic, URL, OP body, and `totalItems` for comment count. Derive status distribution by aggregating `status` and `lastProcessedStatus` across `items`. Skip MCP unless the user explicitly asks for additional thread context.

**MCP mode:** Call `mcp__ebike__get_thread_detail` with `threadId: "$ARGUMENTS"` to understand:

- Thread title, topic/subreddit, URL
- Total comment counts and breakdown by status (new, extracted, relevance_calculated, resolved, approved, in_review)
- Product reference resolution summary

### Step 2 — Processing Trace Summary

**Local file mode:** Derive a status summary from the JSON items (count by `status`, count of items with non-empty `productReferences`, count by `validationDecision`, count by `moderations[].suggestedStatus`). Skip MCP unless the user explicitly asks for the full processed trace summary.

**MCP mode:** Call `mcp__ebike__get_thread_trace_summary` with `threadId: "$ARGUMENTS"` to understand:

- Overall pipeline health and anomalies
- Comment table with statuses
- Any errors or stuck comments

### Step 3 — Sample Approved Comments

**Local file mode:** Filter the JSON `items` where `status === "approved"`, take up to 20.

**MCP mode:** Call `mcp__ebike__search_comments` with `threadId: "$ARGUMENTS"`, `statuses: ["approved"]`, `pageSize: 20`.

### Step 4 — Sample In-Review Comments

**Local file mode:** Filter `items` where `status === "in_review"` (or `validationDecision === "in_review"` on the comment or its `parent`), take up to 20. Inspect `moderations[]` entries for reasons.

**MCP mode:** Call `mcp__ebike__search_comments` with `threadId: "$ARGUMENTS"`, `statuses: ["in_review"]`, `pageSize: 20`.

### Step 5 — Sample Unprocessed / New Comments

**Local file mode:** Filter `items` where `status === "new"` or `status === "skipped"` with no `productReferences` and a non-trivial body, take up to 10.

**MCP mode:** Call `mcp__ebike__search_comments` with `threadId: "$ARGUMENTS"`, `statuses: ["new"]`, `pageSize: 10`.

### Step 6 — Deep-Dive Comment Details

**Local file mode:** Pick up to 5 representative items (mix of approved, in_review, anomalous). The JSON already contains `body`, `parent`, `productReferences` (with resolution candidates), `moderations`, and `validationDecision` — use these directly. Skip MCP unless the user explicitly asks for additional resolution context (e.g. full web search candidates) not present in the file.

**MCP mode:** Call `mcp__ebike__get_comment_detail` on up to 5 representative comments — mix approved, in_review, and any anomalous ones identified in Step 2. Focus on comments that look interesting or problematic based on their body text.

### Step 7 — Pipeline Traces for Flagged Comments (Exact Prompts via Loki)

For flagged or anomalous comments, inspect the **exact LLM prompts and responses via Loki directly** rather than MCP. Loki holds the full prompt body in the debug-level `"Creating AI chat [<provider>:<model>]"` log line and the response in `"AI chat response received [<provider>:<model>]"`, linked by `chatId`. Use the thread ID and (optionally) comment ID to filter.

Useful queries (run via Bash, replacing `<threadId>` and `<commentId>`):

```bash
NOW=$(date +%s); START=$(($NOW - 7*86400))

# All LLM prompts for a thread
curl -s -G "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={service="review-collector",level="debug"} |~ "<threadId>" |~ "Creating AI chat"' \
  --data-urlencode "limit=200" \
  --data-urlencode "start=${START}" \
  --data-urlencode "end=${NOW}" \
  --data-urlencode "direction=forward"

# Responses for a thread (cost, executionTimeInSec, response body)
curl -s -G "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={service="review-collector",level="debug"} |~ "<threadId>" |~ "AI chat response received"' \
  --data-urlencode "limit=200" \
  --data-urlencode "start=${START}" \
  --data-urlencode "end=${NOW}"

# Narrow to a specific comment / subtree by adding another filter line
# ... |~ "<commentId>"

# Processing traces (subtree extraction, validation, scoring decisions)
curl -s -G "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={log_type="processing_trace"} | json | threadId="<threadId>"' \
  --data-urlencode "limit=500" \
  --data-urlencode "start=${START}" \
  --data-urlencode "end=${NOW}" \
  --data-urlencode "direction=forward"
```

Parse the JSON metadata in each returned log line: `messages[0].content` for the prompt body, `response` for the LLM output, plus `model`, `provider`, `cost`, `executionTimeInSec`, `usage`. Only fall back to `mcp__ebike__get_comment_traces` if Loki returns no results (e.g. logs aged out past 30-day retention).

### Step 8 — Verify Missing Products in Database

For every product that appears to be missing from the database (unresolved references, wrong-product flags, or resolution failures identified in Steps 6–7), call `mcp__ebike__search_products` to confirm whether the product actually exists before reporting it as absent. Use the brand name and key model terms as the search term. Only report a product as "missing from the DB" if the search returns no plausible match.

**Local file mode:** This step still uses MCP because the local JSON does not contain the canonical product catalog. Skip it only if the user explicitly asks for a file-only analysis.

---

## Evaluation Criteria

After collecting data, score each criterion **1–10** (10 = perfect). Use concrete evidence from the data.

| #   | Criterion                        | Description                                                                                                                                                                   |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Coverage**                     | What fraction of comments were fully processed through to resolved/approved? Penalise heavily for large "new" backlogs or stuck comments.                                     |
| 2   | **Relevance Precision**          | Among extracted comments, how many actually contain useful purchase-relevant opinions? Penalise false positives (trivial, off-topic, or pure questions extracted as reviews). |
| 3   | **Relevance Recall**             | Based on sampled unprocessed/new comments, are there obvious review-worthy comments being missed? Penalise false negatives.                                                   |
| 4   | **Product Reference Accuracy**   | Are the correct products being identified from comment text? Penalise wrong products, missed mentions, or hallucinated references.                                            |
| 5   | **Product Resolution Quality**   | Are identified product references being matched to the correct product in the database? Penalise wrong matches, missing resolutions, or low-confidence matches.               |
| 6   | **Extraction Depth & Sentiment** | Are the extracted reviews capturing the right sentiment (positive/negative/mixed) and the correct depth (brief/moderate/detailed)?                                            |
| 7   | **Validation Quality**           | Are the validation failures (in_review) legitimate catches of bad extractions, or are valid extractions being incorrectly rejected?                                           |
| 8   | **Auto-Fix Effectiveness**       | Where auto-fix was applied, did it improve comments correctly, or did it introduce errors or leave problems unresolved?                                                       |
| 9   | **Buyer Utility**                | Would the extracted reviews actually help a potential buyer make a decision? Evaluate information quality, specificity, and actionability.                                    |
| 10  | **Data Integrity**               | Are there duplicates, corrupted references, missing required fields, or inconsistent statuses across comments?                                                                |

---

## Output Format

Structure your response as follows:

---

### Thread Overview

Brief summary: thread title, subreddit, total comments, processing status distribution. In local file mode, note the source file path.

---

### Scores

Present a table with score, brief justification, and key evidence for each criterion:

```
| Criterion                  | Score | Justification |
|----------------------------|-------|---------------|
| 1. Coverage                | X/10  | ...           |
| 2. Relevance Precision     | X/10  | ...           |
| ...                        |       |               |
| **FINAL SCORE**            | X/10  | Weighted avg  |
```

For the final score, weight **Relevance Precision (2)**, **Product Reference Accuracy (4)**, **Product Resolution Quality (5)**, and **Buyer Utility (9)** at 1.5× because they directly affect what buyers see.

---

### Top 10 Issues

List issues in descending order of severity. For each issue:

```
#### Issue #N — [Short Title]
**Severity:** Critical / High / Medium / Low
**Criterion affected:** [Which scoring criterion]
**Description:** What is going wrong and why it matters.
**Concrete example:** Quote or describe a specific comment/reference that illustrates the problem (include comment ID if available).
**Suggested fix:** Specific, actionable recommendation — e.g., adjust prompt config, update category matching rules, change relevance threshold, fix a specific extraction prompt example.
```

---

### Summary & Recommendations

2–3 paragraphs summarising the overall health of the extraction for this thread and the highest-leverage actions to improve quality.
