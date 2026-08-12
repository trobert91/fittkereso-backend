// Summarize the extracted identification subtrees, mirroring the 736 report.
import fs from "node:fs";

const PATH =
  "e:/Work/fittkereso/repos/fittkereso-backend/.tmp/identification-subtrees-0dfc.json";
const data = JSON.parse(fs.readFileSync(PATH, "utf-8"));

console.log(`subtreeCount: ${data.subtreeCount}`);
console.log("");

data.subtrees.forEach((sub, idx) => {
  const up = sub.userPrompt;
  const hasOp = up.includes("## OP:");
  const hasCheatSheet = up.includes("## Products identified in this thread:");
  // PLAN nodes: lines containing "[PLAN] cN [d:N]" -- count unique cN.
  const planMatches = [...up.matchAll(/\[PLAN\] (c\d+) \[d:(\d+)\]/g)];
  const planIds = planMatches.map((m) => m[1]);
  // CONTEXT nodes: lines starting/containing "[CONTEXT]" (no [d:N]).
  const contextCount = (up.match(/\[CONTEXT\]/g) || []).length;
  const minIdx =
    planIds.length > 0
      ? Math.min(...planIds.map((c) => Number(c.slice(1))))
      : -1;
  const maxIdx =
    planIds.length > 0
      ? Math.max(...planIds.map((c) => Number(c.slice(1))))
      : -1;

  let summary;
  if (planIds.length === 0) {
    summary = `Subtree ${idx}: (no PLAN nodes)`;
  } else {
    summary = `Subtree ${idx}: PLAN c${minIdx}..c${maxIdx} (${planIds.length} comments)`;
  }
  if (contextCount > 0) summary += ` [+ ${contextCount} CONTEXT]`;
  summary += `  | OP=${hasOp} CheatSheet=${hasCheatSheet}`;
  console.log(summary);
});
