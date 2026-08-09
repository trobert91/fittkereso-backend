/**
 * One-shot helper that scrapes the production extraction prompts out of a
 * Loki/Grafana CSV log export so we can reconstruct a benchmark fixture.
 *
 * Each `Creating AI chat` log line has the shape:
 *   debug: Creating AI chat [<provider>:<model>]: <prefix of system content>
 *   ...                                          {<full JSON metadata>}
 *
 * The trailing JSON carries `messages` (system + user prompt), `model`,
 * `provider`, `subtreeId`, `threadId`, and `chatId`. We locate the JSON
 * by scanning back from the end of the log message to the first `{` that
 * yields valid JSON, then keep only entries whose system message is the
 * extraction system prompt.
 *
 * Usage: npx ts-node scripts/extract-fixture-from-logs.ts <csv-path>
 */

import * as fs from 'fs';
import * as path from 'path';

const EXTRACTION_SYSTEM_PROMPT_HEADER =
  'You extract buyer-useful quote evidence from Reddit comments about';

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-9;]*m/g, '');
}

function* readLineColumn(filePath: string): Generator<string> {
  const raw = fs.readFileSync(filePath, 'utf8');
  let i = 0;
  let inQuotes = false;
  let buf = '';
  let fieldIndex = 0;
  let firstRow = true;
  while (i < raw.length) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"' && raw[i + 1] === '"') {
        buf += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      if (!firstRow && fieldIndex === 2) yield stripAnsi(buf);
      fieldIndex++;
      buf = '';
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (!firstRow && fieldIndex === 2) yield stripAnsi(buf);
      if (firstRow) firstRow = false;
      fieldIndex = 0;
      buf = '';
      if (ch === '\r' && raw[i + 1] === '\n') i += 2;
      else i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (!firstRow && fieldIndex === 2) yield stripAnsi(buf);
}

interface ExtractionCall {
  chatId?: string;
  threadId?: string;
  subtreeId?: string;
  costLabel?: string;
  model?: string;
  provider?: string;
  systemPrompt: string;
  userPrompt: string;
  /** Production log timestamp from the JSON payload. */
  timestamp?: string;
}

/**
 * Parse the trailing `{<json>}` blob out of a `Creating AI chat` log line.
 * The earlier prefix may itself contain `{` characters (it's a substring of
 * the system prompt), so we can't blindly take the first `{`. Instead, walk
 * forward and try parsing each `{` until one succeeds.
 */
function extractTrailingJson(line: string): Record<string, unknown> | null {
  // Heuristic: the JSON we want is the LAST balanced object on the line. Walk
  // backwards from the last `}` to find a matching `{`, then parse.
  const lastClose = line.lastIndexOf('}');
  if (lastClose === -1) return null;

  let depth = 0;
  let openIdx = -1;
  for (let i = lastClose; i >= 0; i--) {
    const ch = line[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        openIdx = i;
        break;
      }
    }
  }
  if (openIdx === -1) return null;

  // Walk forward from openIdx, expanding the start until JSON.parse succeeds.
  // The "real" outer object always opens at the boundary `{"app"`, so try
  // that anchor first.
  for (let start = openIdx; start <= lastClose; start++) {
    if (line[start] !== '{') continue;
    const slice = line.slice(start, lastClose + 1);
    try {
      return JSON.parse(slice) as Record<string, unknown>;
    } catch {
      // try next `{`
    }
  }
  return null;
}

function parseCreatingAiChat(line: string): ExtractionCall | null {
  if (!line.includes('Creating AI chat')) return null;
  const payload = extractTrailingJson(line);
  if (!payload) return null;
  const messages = payload['messages'] as
    | { role?: string; content?: string }[]
    | undefined;
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const system = messages.find((m) => m.role === 'system');
  const user = messages.find((m) => m.role === 'user');
  if (!system || !user) return null;
  if (
    typeof system.content !== 'string' ||
    !system.content.startsWith(EXTRACTION_SYSTEM_PROMPT_HEADER)
  ) {
    return null;
  }
  return {
    chatId: payload['chatId'] as string | undefined,
    threadId: payload['threadId'] as string | undefined,
    subtreeId: payload['subtreeId'] as string | undefined,
    costLabel: payload['costLabel'] as string | undefined,
    model: payload['model'] as string | undefined,
    provider: payload['provider'] as string | undefined,
    systemPrompt: system.content,
    userPrompt: user.content as string,
    timestamp: payload['timestamp'] as string | undefined,
  };
}

function main(): void {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('usage: extract-fixture-from-logs.ts <csv-path>');
    process.exit(1);
  }
  const calls: ExtractionCall[] = [];
  for (const line of readLineColumn(path.resolve(csvPath))) {
    const call = parseCreatingAiChat(line);
    if (call) calls.push(call);
  }
  // Dedup by chatId so retries don't double-count.
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    const key = c.chatId ?? `${c.subtreeId}|${c.userPrompt.length}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.error(`# extraction calls found: ${unique.length}`);
  for (const c of unique) {
    console.error(
      `  subtreeId=${c.subtreeId} model=${c.provider}:${c.model} userPromptLen=${c.userPrompt.length}`,
    );
  }
  process.stdout.write(JSON.stringify(unique, null, 2));
}

main();
