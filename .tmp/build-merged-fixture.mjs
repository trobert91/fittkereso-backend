// Build a merged fixture combining the existing 736 fixture with 4 subtrees
// extracted from the 0dfc thread.
//
// Inputs:
//   - apps/benchmark/fixtures/monitors-thread-sweep-full.fixture.json (12 subtrees, 736 thread)
//   - .tmp/identification-subtrees-0dfc.json (4 subtrees, 0dfc thread)
//
// Output:
//   - apps/benchmark/fixtures/monitors-thread-sweep-merged.fixture.json

import fs from "node:fs";
import path from "node:path";

const ROOT = "e:/Work/fittkereso/repos/fittkereso-backend";
const SOURCE_FIXTURE = path.join(
  ROOT,
  "apps/benchmark/fixtures/monitors-thread-sweep-full.fixture.json",
);
const SOURCE_0DFC = path.join(ROOT, ".tmp/identification-subtrees-0dfc.json");
const TARGET = path.join(
  ROOT,
  "apps/benchmark/fixtures/monitors-thread-sweep-merged.fixture.json",
);

const THREAD = {
  id: "fixture-monitors-thread-sweep-merged",
  title: "Merged: 736b1b30 + 0dfc0e00 ultrawide-monitor threads",
  topic: "r/ultrawidemasterrace",
  subreddit: "r/ultrawidemasterrace",
};

// 0dfc OP author — extracted from the userPrompt's "## OP:" header on subtrees 1+.
const OP_AUTHOR_0DFC = "Significant_Drop_870";

// ---------------- Helpers cribbed from build-fixture.mjs ----------------

function stripMedia(body) {
  return body.replace(/\s*\[Media:\s*[\s\S]*?\]\s*$/, "").replace(/\s+$/, "");
}

function parseHeader(line) {
  let m = line.match(/^\[PLAN\]\s+c(\d+)\s+\[d:(\d+)\]\s*/);
  if (m) {
    let rest = line.slice(m[0].length);
    let author;
    const am = rest.match(/^@(\S+)\s*/);
    if (am) {
      author = am[1];
      rest = rest.slice(am[0].length);
    }
    while (true) {
      const an = rest.match(/^\[(?:owns|used)[^\]]*\]\s*/);
      if (!an) break;
      rest = rest.slice(an[0].length);
    }
    const cm = rest.match(/^:\s*"/);
    if (!cm) return null;
    const headerLen = line.length - rest.length + cm[0].length;
    return { kind: "PLAN", depth: Number(m[2]), author, bodyStart: headerLen };
  }

  m = line.match(/^\[CONTEXT\]\s*/);
  if (m) {
    let rest = line.slice(m[0].length);
    let author;
    const am = rest.match(/^@(\S+)\s*/);
    if (am) {
      author = am[1];
      rest = rest.slice(am[0].length);
    }
    while (true) {
      const an = rest.match(/^\[(?:owns|used)[^\]]*\]\s*/);
      if (!an) break;
      rest = rest.slice(an[0].length);
    }
    const cm = rest.match(/^:\s*"/);
    if (!cm) return null;
    const headerLen = line.length - rest.length + cm[0].length;
    return { kind: "CONTEXT", depth: null, author, bodyStart: headerLen };
  }
  return null;
}

function stripProductsAnnotation(s) {
  return s.replace(/\s*\[products:\s*[^\]]*\]\s*$/, "");
}

function parseCommentsSection(text) {
  const lines = text.split("\n");
  const headerInfos = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indentMatch = raw.match(/^( *)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const trimmed = raw.slice(indent);
    if (!trimmed.startsWith("[PLAN]") && !trimmed.startsWith("[CONTEXT]"))
      continue;
    const header = parseHeader(trimmed);
    if (!header) continue;
    headerInfos.push({ lineIndex: i, indent, header, lineText: raw });
  }

  const nodes = [];
  for (let h = 0; h < headerInfos.length; h++) {
    const cur = headerInfos[h];
    const next = headerInfos[h + 1];

    const startLine = cur.lineIndex;
    const endLineExclusive = next ? next.lineIndex : lines.length;

    const firstLineRaw = lines[startLine];
    const firstSegment = firstLineRaw.slice(cur.indent + cur.header.bodyStart);
    const remainder = lines.slice(startLine + 1, endLineExclusive).join("\n");
    let combined =
      remainder.length > 0 ? firstSegment + "\n" + remainder : firstSegment;

    combined = combined.replace(/\s+$/, "");
    if (cur.header.kind === "CONTEXT") {
      combined = stripProductsAnnotation(combined);
    }
    if (!combined.endsWith('"')) {
      const lastQ = combined.lastIndexOf('"');
      if (lastQ < 0) {
        throw new Error(
          `Unable to find closing quote for header at line ${startLine}`,
        );
      }
      combined = combined.slice(0, lastQ + 1);
    }
    let body = combined.slice(0, -1);
    body = stripMedia(body);
    body = body.replace(/^\s*/, "").replace(/\s+$/, "");

    let depth;
    if (cur.header.kind === "PLAN") {
      depth = cur.header.depth;
    } else {
      depth = Math.floor(cur.indent / 2);
    }

    nodes.push({
      kind: cur.header.kind,
      depth,
      indent: cur.indent,
      author: cur.header.author,
      body,
    });
  }
  return nodes;
}

function assignParents(parsedNodes, externalIds) {
  const parents = new Array(parsedNodes.length).fill(undefined);
  for (let i = 0; i < parsedNodes.length; i++) {
    const cur = parsedNodes[i];
    if (cur.indent === 0) {
      parents[i] = undefined;
      continue;
    }
    let parentIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (parsedNodes[j].indent === cur.indent - 2) {
        parentIdx = j;
        break;
      }
    }
    if (parentIdx < 0) {
      for (let j = i - 1; j >= 0; j--) {
        if (parsedNodes[j].indent < cur.indent) {
          parentIdx = j;
          break;
        }
      }
    }
    parents[i] = parentIdx >= 0 ? externalIds[parentIdx] : undefined;
  }
  return parents;
}

// extractSection cribbed from patch-fixture-context.mjs
function extractSection(prompt, header) {
  const idx = prompt.indexOf(header);
  if (idx === -1) return undefined;
  const start = idx + header.length;
  let bodyStart = start;
  while (bodyStart < prompt.length && prompt[bodyStart] === "\n") bodyStart++;
  const end = prompt.indexOf("\n\n##", bodyStart);
  return prompt.slice(bodyStart, end === -1 ? undefined : end);
}

// ---------------- 0dfc subtree builder ----------------

function build0dfcSubtree(rawSubtree, subtreeIndex) {
  const idx = rawSubtree.userPrompt.indexOf("## Comments to process:");
  if (idx < 0) {
    throw new Error(
      `0dfc subtree ${subtreeIndex} has no '## Comments to process:' marker`,
    );
  }
  const tail = rawSubtree.userPrompt.slice(
    idx + "## Comments to process:".length,
  );
  const text = tail.replace(/^\r?\n/, "");
  const parsed = parseCommentsSection(text);

  let planCounter = 0;
  let ctxCounter = 0;
  const externalIds = parsed.map((n) => {
    if (n.kind === "PLAN") {
      const id = `st0dfc${subtreeIndex}-c${planCounter}`;
      planCounter += 1;
      return id;
    }
    const id = `st0dfc${subtreeIndex}-ctx${ctxCounter}`;
    ctxCounter += 1;
    return id;
  });

  // For subtree 0 (the OP-only subtree): override author for the single PLAN node.
  if (subtreeIndex === 0) {
    for (const n of parsed) {
      if (n.kind === "PLAN" && n.depth === 0 && !n.author) {
        n.author = OP_AUTHOR_0DFC;
      }
    }
  }

  const parents = assignParents(parsed, externalIds);

  const nodes = parsed.map((n, i) => {
    const ordered = { externalId: externalIds[i] };
    if (n.author) ordered.authorName = n.author;
    ordered.body = n.body;
    if (parents[i]) ordered.parentExternalId = parents[i];
    ordered.nodeType = n.kind;
    ordered.depth = n.depth;
    return ordered;
  });

  // Per-subtree opSummary and cheatSheet
  let opSummary = "";
  let cheatSheet = "";
  if (subtreeIndex !== 0) {
    opSummary = extractSection(rawSubtree.userPrompt, "## OP:") ?? "";
    cheatSheet =
      extractSection(
        rawSubtree.userPrompt,
        "## Products identified in this thread:",
      ) ?? "";
  }

  return {
    id: `fixture-thread-sweep-merged-0dfc-${subtreeIndex}`,
    isOpSubtree: subtreeIndex === 0,
    nodes,
    cheatSheet,
    opSummary,
  };
}

// ---------------- Main merge ----------------

function main() {
  const existing = JSON.parse(fs.readFileSync(SOURCE_FIXTURE, "utf-8"));
  const dfcRaw = JSON.parse(fs.readFileSync(SOURCE_0DFC, "utf-8"));

  const existingOpSummary = existing.opSummary;
  if (typeof existingOpSummary !== "string") {
    throw new Error("Existing fixture is missing top-level opSummary");
  }

  // Mutate existing 12 subtrees: add per-subtree opSummary.
  const existing736Subtrees = existing.subtrees.map((st, i) => {
    const opSummary = i === 0 ? "" : existingOpSummary;
    return { ...st, opSummary };
  });

  // Build the 4 0dfc subtrees.
  const dfcSubtrees = dfcRaw.subtrees.map((s, i) => build0dfcSubtree(s, i));

  const fixture = {
    thread: THREAD,
    categoryConfigs: existing.categoryConfigs,
    subtrees: [...existing736Subtrees, ...dfcSubtrees],
  };

  fs.writeFileSync(TARGET, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  // Validation
  const issues = [];

  // 1. Parse round-trip
  try {
    JSON.parse(fs.readFileSync(TARGET, "utf-8"));
  } catch (e) {
    issues.push(`JSON.parse failed: ${e.message}`);
  }

  // 2. Subtree count
  if (fixture.subtrees.length !== 16) {
    issues.push(`Expected 16 subtrees, got ${fixture.subtrees.length}`);
  }

  // 3 & 4. parent resolution & duplicate externalIds
  const allIds = new Set();
  const duplicateIds = [];
  for (const st of fixture.subtrees) {
    for (const n of st.nodes) {
      if (allIds.has(n.externalId)) duplicateIds.push(n.externalId);
      allIds.add(n.externalId);
    }
  }
  if (duplicateIds.length) {
    issues.push(`Duplicate externalIds: ${JSON.stringify(duplicateIds)}`);
  }
  const dangling = [];
  for (const st of fixture.subtrees) {
    for (const n of st.nodes) {
      if (n.parentExternalId && !allIds.has(n.parentExternalId)) {
        dangling.push({
          subtree: st.id,
          externalId: n.externalId,
          parent: n.parentExternalId,
        });
      }
    }
  }
  if (dangling.length) {
    issues.push(`Dangling parentExternalIds: ${JSON.stringify(dangling)}`);
  }

  // 5. First 12 opSummary expectations
  for (let i = 0; i < 12; i++) {
    const st = fixture.subtrees[i];
    if (i === 0) {
      if (st.opSummary !== "")
        issues.push(`Subtree[0] opSummary should be empty`);
    } else {
      if (st.opSummary !== existingOpSummary) {
        issues.push(
          `Subtree[${i}] opSummary does not match original top-level opSummary`,
        );
      }
    }
  }

  // 6. Last 4 expectations
  const dfc0 = fixture.subtrees[12];
  if (dfc0.opSummary !== "" || dfc0.cheatSheet !== "") {
    issues.push(
      `Subtree[12] (0dfc OP subtree) should have empty opSummary and cheatSheet`,
    );
  }
  for (const i of [13, 14, 15]) {
    const st = fixture.subtrees[i];
    if (!st.opSummary || st.opSummary.length === 0)
      issues.push(`Subtree[${i}] opSummary is empty`);
    if (!st.cheatSheet || st.cheatSheet.length === 0)
      issues.push(`Subtree[${i}] cheatSheet is empty`);
  }

  // Report
  console.log(`Wrote: ${TARGET}`);
  console.log(`Total subtrees: ${fixture.subtrees.length}`);
  console.log("");
  console.log("New 4 0dfc subtrees:");
  for (let i = 12; i < 16; i++) {
    const st = fixture.subtrees[i];
    console.log(`  [${i}] ${st.id}  (isOpSubtree=${st.isOpSubtree})`);
    console.log(
      `       nodes=${st.nodes.length}  opSummary.length=${st.opSummary.length}  cheatSheet.length=${st.cheatSheet.length}`,
    );
  }
  console.log("");
  if (issues.length) {
    console.log(`VALIDATION ISSUES (${issues.length}):`);
    for (const issue of issues) console.log(`  - ${issue}`);
  } else {
    console.log("Validation: OK");
  }
}

main();
