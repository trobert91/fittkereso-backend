/**
 * Turn the per-subtree extraction calls dumped by extract-fixture-from-logs.ts
 * into a structured benchmark fixture.
 *
 * The user prompt for each call has the canonical sections:
 *   ## Thread context:
 *   ## OP:
 *   ## Products identified in this thread:
 *   ## Resolved products in this subtree:
 *   ## Comments to process:
 *
 * The cheat sheet and OP summary grow as the pipeline progresses; we keep the
 * latest (= largest) as the fixture-level value, and store per-subtree
 * overrides for any earlier subtree where they differ.
 *
 * Each [PLAN] line has the form:
 *   [PLAN] cN [d:depth] [@author] [affinity-labels]: "body" [products: name (pK), ...]
 *
 * Each [CONTEXT] line:
 *   [indent][CONTEXT] [d:depth] [@author] [affinity-labels]: "body"[products: ...]
 *
 * The resolved-products section maps cN → list of "[pK] displayName (specs)".
 * We turn (a) [PLAN] product annotations and (b) the resolved-products
 * section into the fixture's `resolvedProducts` block keyed by externalId.
 *
 * To wire externalIds into the fixture we cross-reference the thread JSON
 * (the comment dump) — match on author + body. The script writes the
 * generated fixture to stdout.
 *
 * Usage:
 *   npx ts-node scripts/build-extraction-fixture.ts <calls.json> <thread.json>
 */

import * as fs from 'fs';
import * as path from 'path';

interface Call {
  chatId?: string;
  threadId?: string;
  subtreeId?: string;
  systemPrompt: string;
  userPrompt: string;
  timestamp?: string;
}

interface ParsedCommentLine {
  /** PLAN or CONTEXT */
  kind: 'PLAN' | 'CONTEXT';
  /** Short id like c0, c1, ...; only set for PLAN. */
  shortId?: string;
  depth: number;
  /** Display name for the author from the rendered tree, or undefined when omitted. */
  authorName?: string;
  /** Verbatim body. */
  body: string;
  /** Raw "products: ..." annotation when present. */
  productsAnnotation?: string;
  /** Indent level — number of leading "  " pairs. Used to recover parent structure. */
  indent: number;
}

interface ParsedSubtreePrompt {
  call: Call;
  /** OP summary (## OP: section), if present. The OP subtree omits this. */
  opSummary?: string;
  /** Cheat sheet text under "## Products identified in this thread:". */
  cheatSheet: string;
  /** Resolved products lines under "## Resolved products in this subtree:" — keyed by short id. */
  resolvedProducts: Map<string, ResolvedProductEntry[]>;
  /** Subtree comments in DFS order. */
  comments: ParsedCommentLine[];
}

interface ResolvedProductEntry {
  /** "p0", "p1", ... */
  productKey: string;
  /** Display name as rendered. */
  displayName: string;
  /** Spec list as a single string ("34\", oled, 3440x1440, 240 Hz, 800R") or undefined when absent. */
  specsText?: string;
  /** Marked [unresolved] in the rendered string. */
  unresolved: boolean;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')) as T;
}

function splitSections(userPrompt: string): Map<string, string> {
  // Split on lines starting with "## " — keep section title → content.
  const map = new Map<string, string>();
  const lines = userPrompt.split('\n');
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  for (const line of lines) {
    const m = /^## (.+?):\s*$/.exec(line);
    if (m) {
      if (currentTitle) map.set(currentTitle, currentBody.join('\n').trim());
      currentTitle = m[1];
      currentBody = [];
    } else if (currentTitle) {
      currentBody.push(line);
    }
  }
  if (currentTitle) map.set(currentTitle, currentBody.join('\n').trim());
  return map;
}

/**
 * Parse a "## Resolved products in this subtree:" body of the form:
 *   c0: [p0] LG UltraGear OLED 45GX950A-B (44.5", oled, 5120x2160, 165 Hz, 800R), [p1] MSI MPG 321URX/321URXW (31.5", oled, 3840x2160, 240 Hz)
 *   c1: [p0] LG UltraGear OLED 45GX950A-B [unresolved]
 */
function parseResolvedProducts(body: string): Map<string, ResolvedProductEntry[]> {
  const map = new Map<string, ResolvedProductEntry[]>();
  for (const line of body.split('\n')) {
    const m = /^(c\d+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const shortId = m[1];
    const rest = m[2];
    const entries = splitProductEntries(rest);
    map.set(shortId, entries);
  }
  return map;
}

/**
 * Split a comma-separated product list while respecting nested parentheses
 * (specs are themselves parenthesized and contain commas).
 */
function splitProductEntries(rest: string): ResolvedProductEntry[] {
  const out: ResolvedProductEntry[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(parseSingleProductEntry(buf.trim()));
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(parseSingleProductEntry(buf.trim()));
  return out;
}

function parseSingleProductEntry(text: string): ResolvedProductEntry {
  // [pK] Display Name (spec1, spec2) [unresolved]?
  const m = /^\[(p\d+)\]\s+(.+?)(?:\s+\((.*?)\))?(\s+\[unresolved\])?$/.exec(text);
  if (!m) {
    return {
      productKey: '?',
      displayName: text,
      unresolved: text.includes('[unresolved]'),
    };
  }
  return {
    productKey: m[1],
    displayName: m[2].trim(),
    specsText: m[3]?.trim(),
    unresolved: !!m[4],
  };
}

/**
 * Parse a "## Comments to process:" body. Comment bodies may span multiple
 * lines (the renderer does not escape \n inside the quoted body); we
 * recognise [PLAN]/[CONTEXT] as line-start markers and capture every
 * subsequent line until the next marker as the body's continuation.
 */
function parseCommentsSection(body: string): ParsedCommentLine[] {
  const lines = body.split('\n');
  const out: ParsedCommentLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const indentMatch = /^(\s*)/.exec(rawLine);
    const leadingSpaces = indentMatch?.[1].length ?? 0;
    const indent = Math.floor(leadingSpaces / 2);
    const trimmed = rawLine.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    // Detect the marker. [PLAN] carries a short id; [CONTEXT] does not.
    const planHeader =
      /^\[PLAN\]\s+(c\d+)\s+\[d:(\d+)\]\s*(.*)$/.exec(trimmed);
    const ctxHeader = /^\[CONTEXT\]\s+\[d:(\d+)\]\s*(.*)$/.exec(trimmed);
    if (!planHeader && !ctxHeader) {
      i++;
      continue;
    }
    // Gather continuation lines until the next marker line.
    const startIndex = i;
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrimmed = next.trim();
      if (
        /^\[PLAN\]\s+c\d+\s+\[d:\d+\]/.test(nextTrimmed) ||
        /^\[CONTEXT\]\s+\[d:\d+\]/.test(nextTrimmed)
      ) {
        break;
      }
      i++;
    }
    const fullText = lines.slice(startIndex, i).join('\n');
    const parsed = parseSingleCommentBlock(fullText, planHeader, ctxHeader, indent);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseSingleCommentBlock(
  fullText: string,
  planHeader: RegExpExecArray | null,
  ctxHeader: RegExpExecArray | null,
  indent: number,
): ParsedCommentLine | null {
  // Strip the [PLAN] cN [d:D] or [CONTEXT] [d:D] prefix from the front of
  // fullText, then parse the remainder as
  //   (@author )?(<affinity>)?: "<body possibly spanning lines>"<products?>
  let rest: string;
  let kind: 'PLAN' | 'CONTEXT';
  let shortId: string | undefined;
  let depth: number;
  if (planHeader) {
    kind = 'PLAN';
    shortId = planHeader[1];
    depth = parseInt(planHeader[2], 10);
    rest = planHeader[3];
  } else if (ctxHeader) {
    kind = 'CONTEXT';
    depth = parseInt(ctxHeader[1], 10);
    rest = ctxHeader[2];
  } else {
    return null;
  }
  // Splice the rest back together with the trailing lines.
  const indexInFull = fullText.indexOf(rest);
  const tail =
    indexInFull >= 0 ? fullText.slice(indexInFull + rest.length) : '';
  const continuation = tail; // includes leading '\n' when present
  const bodyAndPrefix = rest + continuation;

  // Author / affinity prefix lives before the first colon (": ").
  // The body opens with `"` after the colon, so we find the first `: "`.
  const colonIdx = bodyAndPrefix.indexOf(': "');
  if (colonIdx === -1) {
    console.error(
      'WARN no `: "` in comment block:',
      bodyAndPrefix.slice(0, 120).replace(/\n/g, '\\n'),
    );
    return null;
  }
  const prefix = bodyAndPrefix.slice(0, colonIdx).trim();
  let bodyAndAfter = bodyAndPrefix.slice(colonIdx + 3); // skip past `: "`

  // The body ends at the LAST `"` on the same logical block. The trailing
  // segment may then contain ` [products: ...]`. Find the last `"` and
  // split.
  const lastQuoteIdx = bodyAndAfter.lastIndexOf('"');
  if (lastQuoteIdx === -1) {
    console.error('WARN no closing quote in comment block');
    return null;
  }
  const bodyText = bodyAndAfter.slice(0, lastQuoteIdx);
  const afterQuote = bodyAndAfter.slice(lastQuoteIdx + 1).trim();
  const productsMatch = /^\[products:\s*(.+)\]\s*$/.exec(afterQuote);
  const productsAnnotation = productsMatch?.[1].trim();

  // Author name appears as `@<name>`; affinity tags as `[owns: ...]` or `[used: ...]`.
  const authorMatch = /@(\S+)/.exec(prefix);
  return {
    kind,
    shortId,
    depth,
    authorName: authorMatch?.[1],
    body: bodyText,
    productsAnnotation,
    indent,
  };
}

function parseSubtreePrompt(call: Call): ParsedSubtreePrompt {
  const sections = splitSections(call.userPrompt);
  const opSummary = sections.get('OP');
  const cheatSheet = sections.get('Products identified in this thread') ?? '';
  const resolvedRaw = sections.get('Resolved products in this subtree') ?? '';
  const commentsRaw = sections.get('Comments to process') ?? '';
  return {
    call,
    opSummary,
    cheatSheet,
    resolvedProducts: parseResolvedProducts(resolvedRaw),
    comments: parseCommentsSection(commentsRaw),
  };
}

interface ThreadComment {
  id?: string;
  externalId: string;
  authorName?: string;
  body?: string;
  parentExternalId?: string;
}

/**
 * Walk the thread.json (which uses a deeply nested response shape) and flatten
 * every comment into a Map<body-hash, externalId> for matching back. We use
 * (authorName, body trimmed first 100 chars) as the lookup key.
 */
interface CommentLookupEntry {
  externalId: string;
  parentExternalId?: string;
  authorName?: string;
  body?: string;
}

interface CommentLookup {
  byKey: Map<string, CommentLookupEntry>;
  byExternalId: Map<string, CommentLookupEntry>;
}

function buildCommentLookup(threadJson: { items?: unknown[] }): CommentLookup {
  const byKey = new Map<string, CommentLookupEntry>();
  const byExternalId = new Map<string, CommentLookupEntry>();

  // Each top-level `item` is one comment with its `parent` chain embedded
  // recursively. The chain goes upward (current → parent → grandparent → ...
  // → OP), so we record (current, current.parent.externalId) and then walk up.
  const recordChain = (head: Record<string, unknown> | undefined): void => {
    let cursor: Record<string, unknown> | undefined = head;
    while (cursor) {
      const externalId = cursor['externalId'] as string | undefined;
      const authorName = cursor['authorName'] as string | undefined;
      const body = cursor['body'] as string | undefined;
      const parent = cursor['parent'] as Record<string, unknown> | undefined;
      const parentExternalId = parent
        ? (parent['externalId'] as string | undefined)
        : undefined;
      if (externalId) {
        const entry: CommentLookupEntry = {
          externalId,
          parentExternalId,
          authorName,
          body,
        };
        if (body) {
          const key = makeKey(authorName, body);
          if (!byKey.has(key)) byKey.set(key, entry);
        }
        // First-seen wins so the (deepest) item-level entry — which has the
        // freshest body and parent linkage — sticks.
        if (!byExternalId.has(externalId)) byExternalId.set(externalId, entry);
      }
      cursor = parent;
    }
  };

  for (const item of threadJson.items ?? []) {
    if (!item || typeof item !== 'object') continue;
    recordChain(item as Record<string, unknown>);
  }
  return { byKey, byExternalId };
}

function makeKey(author: string | undefined, body: string): string {
  const bodyKey = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${(author ?? '').toLowerCase()}|${bodyKey.toLowerCase()}`;
}

function findExternalId(
  lookup: CommentLookup,
  authorName: string | undefined,
  body: string,
): { externalId?: string; parentExternalId?: string } {
  const key = makeKey(authorName, body);
  const hit = lookup.byKey.get(key);
  if (hit) return { externalId: hit.externalId, parentExternalId: hit.parentExternalId };
  // Fallback: search by body prefix only.
  for (const [k, v] of lookup.byKey) {
    if (k.endsWith(body.replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase())) {
      return { externalId: v.externalId, parentExternalId: v.parentExternalId };
    }
  }
  return {};
}

function parseSpecsText(specsText: string | undefined): { name: string; value: string }[] {
  if (!specsText) return [];
  // Split by ", " then assign to a generic spec key. The cheat sheet/resolved
  // section in production renders specs in a fixed order:
  //   screenSize, panelType, resolution, refreshRate, curvature
  // ...for monitors. We replicate that ordering by reading the category's
  // primarySpecs from CategoryConfigService at fixture load time, but here
  // we capture the values verbatim — the spec key lookup happens later.
  return specsText.split(/,\s*/).map((value, i) => ({
    name: monitorSpecKeyAtIndex(i),
    value,
  }));
}

/**
 * libs/config/src/lib/categories/monitors/config.json declares the primarySpec
 * order. We hard-code that order here — the order in the rendered string
 * mirrors it exactly. If a different category is ever added, this lookup
 * needs to be parameterized.
 */
function monitorSpecKeyAtIndex(i: number): string {
  return ['screenSize', 'panelType', 'resolution', 'refreshRate', 'curvature'][i] ?? `unknown_${i}`;
}

interface FixtureSubtreeNode {
  externalId: string;
  authorId?: string;
  authorName?: string;
  body: string;
  parentExternalId?: string;
  nodeType: 'PLAN' | 'CONTEXT';
  depth: number;
}

interface FixtureResolvedProduct {
  brand: string;
  model: string;
  displayName: string;
  categorySlug?: string;
  specs?: { name: string; value: string }[];
  unresolved?: boolean;
}

interface FixtureSubtree {
  id: string;
  isOpSubtree: boolean;
  nodes: FixtureSubtreeNode[];
  cheatSheet?: string;
  opSummary?: string;
  resolvedProducts?: Record<string, FixtureResolvedProduct[]>;
}

function splitBrandModel(displayName: string): { brand: string; model: string } {
  // Heuristic: brand is the first space-separated token. Works for the
  // monitors data set; revisit if other categories show up.
  const parts = displayName.split(/\s+/);
  if (parts.length === 1) return { brand: parts[0], model: '' };
  return { brand: parts[0], model: parts.slice(1).join(' ') };
}

function buildFixtureSubtree(
  parsed: ParsedSubtreePrompt,
  lookup: ReturnType<typeof buildCommentLookup>,
  globalCheatSheet: string,
  globalOpSummary: string | undefined,
): FixtureSubtree {
  const nodes: FixtureSubtreeNode[] = [];
  // Track parent via indent stack so reconstructed parentExternalId is correct
  // for subtrees whose [CONTEXT] chain wasn't fully captured by the thread JSON.
  const stack: { depth: number; externalId: string }[] = [];
  const planExternalIds: string[] = [];
  for (const c of parsed.comments) {
    const { externalId, parentExternalId } = findExternalId(
      lookup,
      c.authorName,
      c.body,
    );
    if (!externalId) {
      console.error(
        `WARN no externalId for ${c.authorName} / ${c.body.slice(0, 60)}`,
      );
      continue;
    }
    // Maintain stack: pop while top.depth >= c.depth.
    while (stack.length > 0 && stack[stack.length - 1].depth >= c.depth) stack.pop();
    const parentFromStack = stack.length > 0 ? stack[stack.length - 1].externalId : undefined;
    nodes.push({
      externalId,
      // Use authorName as a stable authorId fallback so the renderer's
      // per-subtree authorCount and getAuthorAffinity lookups can both engage.
      // Real Reddit IDs would be more correct but they're not in the rendered
      // logs we reconstruct from.
      authorId: c.authorName ? `t2_${c.authorName.toLowerCase()}` : undefined,
      authorName: c.authorName,
      body: c.body,
      parentExternalId: parentExternalId ?? parentFromStack,
      nodeType: c.kind,
      depth: c.depth,
    });
    stack.push({ depth: c.depth, externalId });
    if (c.kind === 'PLAN') planExternalIds.push(externalId);
  }

  // Production extraction subtrees include CONTEXT nodes for the parent chain
  // of every PLAN node (stripped from the rendered prompt by stripContext:true,
  // but counted by the renderer's per-subtree author-count loop). The
  // recovered prompt only shows PLAN lines, so we reconstruct CONTEXT ancestors
  // here from the thread JSON. Without this, authors who appeared exactly once
  // as PLAN would not get `@author` rendered, while production rendered them
  // because their CONTEXT parent shared the authorId or formed an affinity
  // signal.
  const presentExtIds = new Set(nodes.map((n) => n.externalId));
  const contextNodes: FixtureSubtreeNode[] = [];
  for (const planExtId of planExternalIds) {
    let cursor: string | undefined = planExtId;
    while (cursor) {
      const meta = lookup.byExternalId.get(cursor);
      const parentExtId = meta?.parentExternalId;
      if (!parentExtId) break;
      if (presentExtIds.has(parentExtId)) {
        cursor = parentExtId;
        continue;
      }
      const parentMeta = lookup.byExternalId.get(parentExtId);
      if (!parentMeta) break;
      // Depth is irrelevant when stripContext: true — these CONTEXT nodes are
      // never rendered. They exist only so the per-subtree authorCount loop
      // sees the same author counts production saw.
      contextNodes.push({
        externalId: parentExtId,
        authorId: parentMeta.authorName
          ? `t2_${parentMeta.authorName.toLowerCase()}`
          : undefined,
        authorName: parentMeta.authorName,
        body: parentMeta.body ?? '',
        parentExternalId: parentMeta.parentExternalId,
        nodeType: 'CONTEXT',
        depth: 0,
      });
      presentExtIds.add(parentExtId);
      cursor = parentExtId;
    }
  }
  nodes.push(...contextNodes);

  // Convert resolvedProducts (keyed by short id) → keyed by externalId.
  const resolvedByExternalId: Record<string, FixtureResolvedProduct[]> = {};
  const planNodes = parsed.comments.filter((c) => c.kind === 'PLAN');
  for (const planNode of planNodes) {
    const shortId = planNode.shortId;
    if (!shortId) continue;
    const entries = parsed.resolvedProducts.get(shortId);
    if (!entries || entries.length === 0) continue;
    const { externalId } = findExternalId(lookup, planNode.authorName, planNode.body);
    if (!externalId) continue;
    resolvedByExternalId[externalId] = entries.map((e) => {
      const { brand, model } = splitBrandModel(e.displayName);
      const out: FixtureResolvedProduct = {
        brand,
        model,
        displayName: e.displayName,
        categorySlug: 'monitors',
        specs: parseSpecsText(e.specsText),
      };
      if (e.unresolved) out.unresolved = true;
      return out;
    });
  }

  const isOpSubtree = !parsed.opSummary; // OP subtree omits the OP summary
  const subtree: FixtureSubtree = {
    id: parsed.call.subtreeId ?? `subtree-${parsed.call.chatId}`,
    isOpSubtree,
    nodes,
    resolvedProducts:
      Object.keys(resolvedByExternalId).length > 0 ? resolvedByExternalId : undefined,
  };

  // Per-subtree overrides: only set when the subtree's value differs from the
  // global one. Reduces fixture noise.
  if (parsed.cheatSheet && parsed.cheatSheet !== globalCheatSheet) {
    subtree.cheatSheet = parsed.cheatSheet;
  }
  if (parsed.opSummary && parsed.opSummary !== globalOpSummary) {
    subtree.opSummary = parsed.opSummary;
  }
  return subtree;
}

function buildIdentificationResults(
  parsed: ParsedSubtreePrompt,
  lookup: ReturnType<typeof buildCommentLookup>,
): Record<string, { brand: string; model: string; categoryHint?: string; contentQuality: 'high' | 'medium' | 'low' }[]> {
  // Production identifies products and the "[products: name (pK), ...]"
  // annotation on each PLAN line is the resolved set. We re-emit those as
  // identificationResults — the brand/model comes from the resolved-products
  // parsing.
  const out: Record<
    string,
    {
      brand: string;
      model: string;
      categoryHint?: string;
      contentQuality: 'high' | 'medium' | 'low';
    }[]
  > = {};
  const planNodes = parsed.comments.filter((c) => c.kind === 'PLAN');
  for (const planNode of planNodes) {
    const shortId = planNode.shortId;
    if (!shortId) continue;
    const entries = parsed.resolvedProducts.get(shortId);
    if (!entries || entries.length === 0) continue;
    const { externalId } = findExternalId(lookup, planNode.authorName, planNode.body);
    if (!externalId) continue;
    out[externalId] = entries.map((e) => {
      const { brand, model } = splitBrandModel(e.displayName);
      return {
        brand,
        model,
        categoryHint: 'monitor',
        contentQuality: 'medium',
      };
    });
  }
  return out;
}

/**
 * Walk each prompt's comments section to find inline affinity tags like
 *   `@AnurinXx [used: MSI MPG341CQPX]`
 * and emit a per-author affinity entry the fixture loader will replay back
 * into `context.authorProductAffinity`. Keys are authorIds we synthesize
 * from authorNames the same way buildFixtureSubtree does.
 */
function extractAuthorAffinity(
  prompts: ParsedSubtreePrompt[],
): Record<string, { experience: 'owner' | 'prior_owner' | 'tested'; productDisplayName: string }[]> {
  const out: Record<
    string,
    { experience: 'owner' | 'prior_owner' | 'tested'; productDisplayName: string }[]
  > = {};
  const seen = new Set<string>();
  const re = /@(\S+)\s+\[(owns|used):\s*([^\]]+)\]/g;
  for (const p of prompts) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.call.userPrompt)) !== null) {
      const authorName = m[1];
      const verb = m[2] as 'owns' | 'used';
      const products = m[3].split(',').map((s) => s.trim()).filter(Boolean);
      const authorId = `t2_${authorName.toLowerCase()}`;
      const list = (out[authorId] = out[authorId] ?? []);
      for (const productDisplayName of products) {
        const key = `${authorId}|${verb}|${productDisplayName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          experience: verb === 'owns' ? 'owner' : 'tested',
          productDisplayName,
        });
      }
    }
  }
  return out;
}

function pickGlobalCheatSheet(prompts: ParsedSubtreePrompt[]): string {
  // The latest (chronologically last) prompt has the largest cheat sheet.
  let best = '';
  for (const p of prompts) {
    if (p.cheatSheet.length > best.length) best = p.cheatSheet;
  }
  return best;
}

function pickGlobalOpSummary(prompts: ParsedSubtreePrompt[]): string | undefined {
  for (const p of prompts) {
    if (p.opSummary && p.opSummary.length > 0) return p.opSummary;
  }
  return undefined;
}

function main(): void {
  const callsPath = process.argv[2];
  const threadPath = process.argv[3];
  if (!callsPath || !threadPath) {
    console.error('usage: build-extraction-fixture.ts <calls.json> <thread.json>');
    process.exit(1);
  }
  const calls = readJson<Call[]>(callsPath);
  const threadJson = readJson<{ items: unknown[] }>(threadPath);
  const lookup = buildCommentLookup(threadJson);

  // Sort prompts in chronological order so the fixture's per-subtree array is
  // deterministic and matches the production processing order.
  const parsed = calls
    .map(parseSubtreePrompt)
    .sort((a, b) => (a.call.timestamp ?? '').localeCompare(b.call.timestamp ?? ''));

  const globalCheatSheet = pickGlobalCheatSheet(parsed);
  const globalOpSummary = pickGlobalOpSummary(parsed);

  const subtrees: FixtureSubtree[] = [];
  const aggregateIdentification: Record<
    string,
    { brand: string; model: string; categoryHint?: string; contentQuality: 'high' | 'medium' | 'low' }[]
  > = {};
  for (const p of parsed) {
    subtrees.push(buildFixtureSubtree(p, lookup, globalCheatSheet, globalOpSummary));
    Object.assign(aggregateIdentification, buildIdentificationResults(p, lookup));
  }

  const authorAffinity = extractAuthorAffinity(parsed);

  const fixture = {
    thread: {
      id: 'thread-736b1b30',
      title: "Best 34'' 240 Hz OLED ultrawide to date?",
      topic: 'r/ultrawidemasterrace',
      subreddit: 'r/ultrawidemasterrace',
    },
    categoryConfigs: [
      {
        categoryId: 'monitors',
        categoryName: 'Monitors',
        confidence: 0.95,
        promptConfig: {
          validSpecs: [
            { name: 'refreshRate', examples: '240Hz, 144Hz, 175Hz' },
            { name: 'panelType', examples: 'OLED, QD-OLED, IPS, VA' },
            { name: 'resolution', examples: '3440x1440, 4K' },
            { name: 'screenSize', examples: '34", 39", 27"' },
            { name: 'curvature', examples: '1800R, 800R, 1500R' },
          ],
          productIdExamples: [],
          technologyDescriptors: ['OLED', 'QD-OLED', 'WOLED'],
          specialInstructions: [
            "Panel type alone (IPS, VA, OLED, QD-OLED) is NOT a product — only extract when attached to a brand or model name.",
            "Screen size specs: extract as { \"name\": \"screenSize\", \"value\": \"39\\\"\" } only when the commenter directly attributes a size to the reviewed product AND it differs from the cheat sheet value. NEVER extract from a 'coming from' / 'upgrading from' sentence (that size belongs to the previous device).",
            "VRR feature covers G-Sync, FreeSync, and adaptive-sync behavior — black screen flickers, signal loss, VRR incompatibility with HDR.",
            "Motion clarity covers ghosting, smearing, and perceived response time during fast motion — NOT the response-time spec value.",
            "Refresh rate is the Hz spec itself, not VRR behavior. Do not confuse VRR issues with motion clarity.",
            "When comparing this monitor to another product, a store demo, or an unnamed 'the others', keep ONLY the clause that directly evaluates this monitor. Baseline clauses like 'the 800R curve was too much when I looked at one at Best Buy' must NOT be attached to the resolved product unless they clearly refer to it.",
            "For prospective buyers, reasoned preferences count (design, panel type, price, brand reputation) alongside named concerns. Skip only vague lines like 'huge gamble' or 'best option' with no supporting reason.",
          ].join('\n'),
          productTypeWord: 'monitor',
        },
        features: [
          { label: 'colors' },
          { label: 'HDR' },
          { label: 'motion clarity' },
          { label: 'text clarity' },
          { label: 'curvature' },
          { label: 'coating' },
          { label: 'glare handling' },
          { label: 'design' },
          { label: 'value' },
          { label: 'production quality' },
          { label: 'VRR' },
          { label: 'screen size' },
        ],
        useCases: [],
      },
    ],
    opSummary: globalOpSummary,
    cheatSheet: globalCheatSheet,
    subtrees,
    identificationResults: aggregateIdentification,
    extractionOptions: {
      maxFocusCategories: 1,
      maxQuotesCeiling: 6,
      stripContext: true,
      validSpecNames: ['refreshRate', 'panelType', 'resolution', 'screenSize', 'curvature'],
    },
    authorAffinity,
  };

  process.stdout.write(JSON.stringify(fixture, null, 2));
  console.error(`# subtrees: ${subtrees.length}`);
  console.error(`# total nodes: ${subtrees.reduce((acc, s) => acc + s.nodes.length, 0)}`);
  console.error(`# identification entries: ${Object.keys(aggregateIdentification).length}`);
}

main();
