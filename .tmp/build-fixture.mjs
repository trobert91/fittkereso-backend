// Build a FixtureFile JSON from .tmp/identification-subtrees.json by parsing the
// rendered "## Comments to process:" section of each subtree's userPrompt.
//
// Output: apps/benchmark/fixtures/monitors-thread-sweep-full.fixture.json

import fs from "node:fs";
import path from "node:path";

const SOURCE =
  "e:/Work/ebike/repos/ebike-backend/.tmp/identification-subtrees.json";
const TARGET =
  "e:/Work/ebike/repos/ebike-backend/apps/benchmark/fixtures/monitors-thread-sweep-full.fixture.json";

const THREAD = {
  id: "fixture-monitors-thread-sweep-full",
  title: "Best 34'' 240 Hz OLED ultrawide to date?",
  topic: "r/ultrawidemasterrace",
  subreddit: "r/ultrawidemasterrace",
};

const CATEGORY_CONFIGS = [
  {
    categoryId: "fixture-monitors",
    categoryName: "Monitors",
    confidence: 0.95,
    promptConfig: {
      validSpecs: [
        { name: "refreshRate", examples: "240Hz, 144Hz" },
        { name: "panelType", examples: "OLED, QD-OLED, WOLED, IPS, VA" },
        { name: "resolution", examples: "3440x1440, 4K" },
        { name: "screenSize", examples: '34", 39", 27"' },
        { name: "curvature", examples: "800R, 1800R, 1500R" },
      ],
      productIdExamples: [
        { mentioned: "MSI MPG 341CQPX", brand: "MSI", model: "MPG 341CQPX" },
        { mentioned: "LG 34GS95QE", brand: "LG", model: "34GS95QE-B" },
      ],
      technologyDescriptors: ["OLED", "QD-OLED", "WOLED"],
      specialInstructions: "",
      searchKeywordInstruction:
        "Include the model name and a differing spec value.",
      productTypeWord: "monitor",
    },
    useCases: ["pc gaming", "media", "content creation"],
    featureLabels: [
      "color accuracy",
      "HDR",
      "response time",
      "burn-in",
      "text clarity",
    ],
    featureConfigs: [],
    useCaseConfigs: [],
  },
];

/**
 * Strip [Media: ...] blocks at the end of a body. The block can span multiple
 * lines (it contains JSON). We handle the simple case where it's the trailing
 * segment after a newline.
 */
function stripMedia(body) {
  return body.replace(/\s*\[Media:\s*[\s\S]*?\]\s*$/, "").replace(/\s+$/, "");
}

/**
 * Parse a single comment line header. Returns:
 *   { kind: 'PLAN'|'CONTEXT', depth, author, bodyStart }
 * where bodyStart is the index in `line` where the body starts (just after `: "`).
 * Returns null if the line is not a recognized header line.
 *
 * Header forms (after leading indent):
 *   [PLAN] cN [d:N] [@author] [annot] : "...
 *   [CONTEXT] [@author] [annot] : "...
 */
function parseHeader(line) {
  // PLAN header: cN required, may have author and annotation
  let m = line.match(/^\[PLAN\]\s+c(\d+)\s+\[d:(\d+)\]\s*/);
  if (m) {
    let rest = line.slice(m[0].length);
    let author;
    const am = rest.match(/^@(\S+)\s*/);
    if (am) {
      author = am[1];
      rest = rest.slice(am[0].length);
    }
    // Strip optional annotations like [owns: ...] [used: ...] (greedy across multiple bracket groups)
    while (true) {
      const an = rest.match(/^\[(?:owns|used)[^\]]*\]\s*/);
      if (!an) break;
      rest = rest.slice(an[0].length);
    }
    // Now expect: ': "'
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
    // CONTEXT lines do not carry [d:N]; we'll infer depth from indentation.
    return { kind: "CONTEXT", depth: null, author, bodyStart: headerLen };
  }
  return null;
}

/**
 * Strip a trailing `[products: ...]` annotation that appears after the closing
 * quote of a CONTEXT body. Returns the cleaned line/segment.
 */
function stripProductsAnnotation(s) {
  return s.replace(/\s*\[products:\s*[^\]]*\]\s*$/, "");
}

/**
 * Walk the comments section line by line. For each header line we find, the
 * body starts after `: "` on that same line and extends until the closing `"`
 * which is the last `"` before the next header line (or end).
 */
function parseCommentsSection(text) {
  const lines = text.split("\n");
  // Identify which line indices are header lines.
  const headerInfos = []; // { lineIndex, indent, header }
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

    // Build the raw body string by concatenating lines from the header line
    // to the line before the next header (or end of text).
    const startLine = cur.lineIndex;
    const endLineExclusive = next ? next.lineIndex : lines.length;

    // First line: start at bodyStart relative to the trimmed line; bodyStart was
    // computed against `trimmed`, so add cur.indent to map back to the raw line.
    const firstLineRaw = lines[startLine];
    const firstSegment = firstLineRaw.slice(cur.indent + cur.header.bodyStart);
    const remainder = lines.slice(startLine + 1, endLineExclusive).join("\n");
    let combined =
      remainder.length > 0 ? firstSegment + "\n" + remainder : firstSegment;

    // The body is everything up through the LAST closing quote in `combined`.
    // For CONTEXT lines a trailing ` [products: ...]` may follow that closing
    // quote on the same logical line; trim trailing whitespace first.
    combined = combined.replace(/\s+$/, "");
    if (cur.header.kind === "CONTEXT") {
      combined = stripProductsAnnotation(combined);
    }
    if (!combined.endsWith('"')) {
      // Fallback: try to find the last closing quote.
      const lastQ = combined.lastIndexOf('"');
      if (lastQ < 0) {
        throw new Error(
          `Unable to find closing quote for header at line ${startLine}`,
        );
      }
      combined = combined.slice(0, lastQ + 1);
    }
    // Strip the trailing closing quote.
    let body = combined.slice(0, -1);
    // The body has already been JSON-decoded by the outer JSON.parse, so any
    // remaining sequences are literal. We do nothing further to escape chars.
    body = stripMedia(body);
    body = body.replace(/^\s*/, "").replace(/\s+$/, "");

    let depth;
    if (cur.header.kind === "PLAN") {
      depth = cur.header.depth;
    } else {
      // CONTEXT: infer from indentation (2 spaces per depth level).
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

/**
 * Build the parent linkage based on indentation. The parent of a node is the
 * most recent earlier node whose indent is strictly less than the current
 * node's indent (i.e. one level up in the rendered tree). Falls back to the
 * most recent earlier node at indent === currentIndent - 2 if available; this
 * is the cleanest "2-space-per-depth" rule.
 */
function assignParents(parsedNodes, externalIds) {
  const parents = new Array(parsedNodes.length).fill(undefined);
  for (let i = 0; i < parsedNodes.length; i++) {
    const cur = parsedNodes[i];
    if (cur.indent === 0) {
      parents[i] = undefined;
      continue;
    }
    // Walk backward looking for the nearest earlier node with indent === cur.indent - 2.
    // Fall back to any node with indent < cur.indent.
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

function buildSubtree(rawSubtree, subtreeIndex) {
  const idx = rawSubtree.userPrompt.indexOf("## Comments to process:");
  if (idx < 0) {
    throw new Error(
      `Subtree ${subtreeIndex} has no '## Comments to process:' marker`,
    );
  }
  const tail = rawSubtree.userPrompt.slice(
    idx + "## Comments to process:".length,
  );
  // Drop the leading newline that follows the header.
  const text = tail.replace(/^\r?\n/, "");
  const parsed = parseCommentsSection(text);

  // Allocate externalIds: PLAN gets stN-cP (P = plan index within this subtree),
  // CONTEXT gets stN-ctxC (C = context index within this subtree).
  let planCounter = 0;
  let ctxCounter = 0;
  const externalIds = parsed.map((n) => {
    if (n.kind === "PLAN") {
      const id = `st${subtreeIndex}-c${planCounter}`;
      planCounter += 1;
      return id;
    }
    const id = `st${subtreeIndex}-ctx${ctxCounter}`;
    ctxCounter += 1;
    return id;
  });

  // For subtree 0 (the OP subtree) we must override author for the single PLAN node.
  if (subtreeIndex === 0) {
    for (const n of parsed) {
      if (n.kind === "PLAN" && n.depth === 0 && !n.author) {
        n.author = "No_Committee8856";
      }
    }
  }

  const parents = assignParents(parsed, externalIds);

  const nodes = parsed.map((n, i) => {
    const node = {
      externalId: externalIds[i],
      body: n.body,
      nodeType: n.kind,
      depth: n.depth,
    };
    if (n.author) node.authorName = n.author;
    if (parents[i]) node.parentExternalId = parents[i];
    // Reorder for readability: externalId, authorName, body, parentExternalId, nodeType, depth
    const ordered = {
      externalId: node.externalId,
    };
    if (node.authorName !== undefined) ordered.authorName = node.authorName;
    ordered.body = node.body;
    if (node.parentExternalId !== undefined)
      ordered.parentExternalId = node.parentExternalId;
    ordered.nodeType = node.nodeType;
    ordered.depth = node.depth;
    return ordered;
  });

  return {
    id: `fixture-thread-sweep-st-${subtreeIndex}`,
    isOpSubtree: subtreeIndex === 0,
    nodes,
  };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(SOURCE, "utf-8"));
  const subtrees = raw.subtrees.map((s, i) => buildSubtree(s, i));

  const fixture = {
    thread: THREAD,
    categoryConfigs: CATEGORY_CONFIGS,
    subtrees,
  };

  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  // Verification
  const allIds = new Set();
  for (const st of subtrees) for (const n of st.nodes) allIds.add(n.externalId);
  const dangling = [];
  let totalNodes = 0;
  for (const st of subtrees) {
    totalNodes += st.nodes.length;
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
  console.log(`Subtrees: ${subtrees.length}`);
  console.log(`Total nodes: ${totalNodes}`);
  console.log(
    `Per-subtree node counts: ${subtrees.map((s) => s.nodes.length).join(", ")}`,
  );
  console.log(`Dangling parentExternalIds: ${dangling.length}`);
  if (dangling.length) console.log(JSON.stringify(dangling, null, 2));
  console.log(`Wrote: ${TARGET}`);
}

main();
