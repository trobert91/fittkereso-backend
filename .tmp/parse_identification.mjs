// Stream-parse the logs CSV and extract identification-phase LLM calls.
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";

const CSV_PATH =
  "e:/Work/fittkereso/repos/fittkereso-backend/docs/thread-extraction/736b1b30-d7da-4ddf-8504-a6957b64c789-logs.csv";
const OUT_PATH =
  "e:/Work/fittkereso/repos/fittkereso-backend/.tmp/identification-subtrees.json";

const IDENTIFICATION_PROMPT_PREFIX =
  "You identify which products each Reddit comment references.";
const RECEIVED_MARKER = "AI chat response received [openai:gpt-5.4-mini]";

/**
 * Parse a single CSV row, accounting for RFC-4180 doubled-quote escaping ("").
 * Returns an array of fields. Assumes the row is one logical line (no embedded newlines —
 * the CSV here is one logical entry per file line).
 */
function parseCsvRow(line) {
  const fields = [];
  let i = 0;
  let cur = "";
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    // not in quotes
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      fields.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  fields.push(cur);
  return fields;
}

/**
 * Find the largest balanced JSON object inside a string and return the parsed object
 * with the most keys. Returns null if none found.
 */
function findBestJsonObject(text) {
  let best = null;
  let bestKeys = -1;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let end = start; end < text.length; end++) {
      const ch = text[end];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, end + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              const keyCount = Object.keys(obj).length;
              if (keyCount > bestKeys) {
                best = obj;
                bestKeys = keyCount;
              }
            }
          } catch {
            // not valid JSON; ignore
          }
          break;
        }
      }
    }
  }
  return best;
}

async function run() {
  const stream = fs.createReadStream(CSV_PATH, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = null;
  let lineColIdx = -1;
  let tsColIdx = -1;
  const calls = [];

  let lineNum = 0;
  for await (const rawLine of rl) {
    lineNum += 1;
    if (!rawLine) continue;
    if (header === null) {
      header = parseCsvRow(rawLine);
      lineColIdx = header.indexOf("Line");
      tsColIdx = header.indexOf("tsNs");
      continue;
    }
    // Cheap pre-filter: skip rows we obviously don't want.
    if (!rawLine.includes(RECEIVED_MARKER)) continue;
    if (!rawLine.includes(IDENTIFICATION_PROMPT_PREFIX)) continue;

    const fields = parseCsvRow(rawLine);
    if (lineColIdx < 0 || lineColIdx >= fields.length) continue;
    const line = fields[lineColIdx];
    const tsNs =
      tsColIdx >= 0 && tsColIdx < fields.length ? fields[tsColIdx] : "";

    if (!line.includes(RECEIVED_MARKER)) continue;
    if (!line.includes(IDENTIFICATION_PROMPT_PREFIX)) continue;

    const payload = findBestJsonObject(line);
    if (!payload) continue;
    const messages = payload.messages;
    if (!Array.isArray(messages) || messages.length < 2) continue;
    const sysContent = messages[0]?.content;
    if (typeof sysContent !== "string") continue;
    if (!sysContent.startsWith(IDENTIFICATION_PROMPT_PREFIX)) continue;
    const userContent = messages[1]?.content;
    const userPrompt =
      typeof userContent === "string"
        ? userContent
        : JSON.stringify(userContent);
    const response =
      typeof payload.response === "string"
        ? payload.response
        : payload.response != null
          ? JSON.stringify(payload.response)
          : "";
    const chatId = payload.chatId || payload.chat_id || "";
    const subtreeId = payload.subtreeId || payload.subtree_id || "";

    calls.push({ tsNs, chatId, subtreeId, userPrompt, response });
  }

  // Sort chronologically (oldest first); tsNs is numeric (BigInt-safe compare via string length first).
  calls.sort((a, b) => {
    const aa = a.tsNs || "0";
    const bb = b.tsNs || "0";
    if (aa.length !== bb.length) return aa.length - bb.length;
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  });

  const out = {
    subtreeCount: calls.length,
    subtrees: calls.map((c) => ({
      chatId: c.chatId,
      subtreeId: c.subtreeId,
      userPrompt: c.userPrompt,
      response: c.response,
    })),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf-8");

  console.log(`Found ${calls.length} identification calls`);
  console.log(`Wrote: ${OUT_PATH}`);
  if (calls.length > 0) {
    const first = calls[0];
    console.log(`\nFirst subtreeId: ${first.subtreeId}`);
    console.log(`First chatId: ${first.chatId}`);
    const idx = first.userPrompt.indexOf("## Comments");
    const snippet =
      idx >= 0
        ? first.userPrompt.slice(idx, idx + 1800)
        : first.userPrompt.slice(0, 1800);
    console.log("\n--- First subtree Comments section snippet ---");
    console.log(snippet);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
