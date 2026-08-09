// Lift the OP summary and per-subtree cheat sheets out of the logged production
// userPrompts (in identification-subtrees.json) and patch them into the
// monitors-thread-sweep-full fixture so the benchmark prompt matches prod.
import * as fs from "node:fs";
import * as path from "node:path";

const root = "e:/Work/ebike/repos/ebike-backend";
const subtreesPath = path.join(root, ".tmp", "identification-subtrees.json");
const fixturePath = path.join(
  root,
  "apps/benchmark/fixtures/monitors-thread-sweep-full.fixture.json",
);

const subtreesData = JSON.parse(fs.readFileSync(subtreesPath, "utf8"));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

// Extract a section bounded by a header and the next double-newline + ##.
// Returns the inner text (after the header line, before the next section).
function extractSection(prompt, header) {
  const idx = prompt.indexOf(header);
  if (idx === -1) return undefined;
  const start = idx + header.length;
  // Skip leading newline(s) right after the header.
  let bodyStart = start;
  while (bodyStart < prompt.length && prompt[bodyStart] === "\n") bodyStart++;
  // The section ends at the next "\n\n##" (start of the next H2) or EOF.
  const end = prompt.indexOf("\n\n##", bodyStart);
  return prompt.slice(bodyStart, end === -1 ? undefined : end);
}

// Pull OP summary: appears under "## OP:" in subtrees 1..11 (subtree 0 is OP-only).
let opSummary;
for (let i = 1; i < subtreesData.subtrees.length; i++) {
  const s = subtreesData.subtrees[i].userPrompt;
  const section = extractSection(s, "## OP:");
  if (section) {
    opSummary = section;
    break;
  }
}
if (!opSummary) {
  throw new Error('Could not locate "## OP:" section in any non-OP subtree.');
}

// Pull per-subtree cheat sheet from "## Products identified in this thread:".
// Subtree 0 (the OP) has no cheat sheet — empty string is correct, since prod
// also injects nothing for the OP subtree.
const cheatSheets = subtreesData.subtrees.map((s, idx) => {
  if (idx === 0) return ""; // OP subtree
  const section = extractSection(
    s.userPrompt,
    "## Products identified in this thread:",
  );
  return section ?? "";
});

// Patch the fixture in place: top-level opSummary + per-subtree cheatSheet.
fixture.opSummary = opSummary;
for (let i = 0; i < fixture.subtrees.length; i++) {
  fixture.subtrees[i].cheatSheet = cheatSheets[i];
}

fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");

// Sanity report.
console.log("opSummary length:", opSummary.length);
console.log("cheatSheet lengths per subtree:");
cheatSheets.forEach((cs, i) => {
  console.log(
    `  st${i}: ${cs.length} chars` +
      (cs.length > 0 ? `, first line: ${cs.split("\n")[0]}` : ""),
  );
});
console.log("Fixture written to:", fixturePath);
