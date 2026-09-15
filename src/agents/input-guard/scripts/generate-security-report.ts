import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { handler } from "../src/index";
import { SECURITY_CASES } from "../src/security/cases";

// Runs the same case list prompt-injection-suite.test.ts asserts against, and writes a
// human-readable report to results/ -- the "results/ demo outputs / audit evidence"
// folder named in the Phase-I repo structure (docs/spec.md). This is the citable
// artifact for Objectives.docx objective 5's verification method and for the Phase-II
// report (task 22), not a substitute for the pass/fail test suite itself.
async function main() {
  const rows: { case: (typeof SECURITY_CASES)[number]; actualFlagged: boolean; pass: boolean }[] = [];

  for (const testCase of SECURITY_CASES) {
    const result = await handler({ requestId: `security-${testCase.id}`, rawInput: testCase.payload });
    rows.push({
      case: testCase,
      actualFlagged: result.flagged,
      pass: result.flagged === testCase.expectedFlagged,
    });
  }

  const total = rows.length;
  const passed = rows.filter((r) => r.pass).length;
  const byCategory = new Map<string, { total: number; passed: number }>();
  for (const row of rows) {
    const entry = byCategory.get(row.case.category) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (row.pass) entry.passed += 1;
    byCategory.set(row.case.category, entry);
  }

  const lines: string[] = [];
  lines.push("# SAGE Input Guard -- Prompt-Injection Verification Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Verification method for Objectives.docx objective 5 (\"better security\": explicit Input Guard " +
      "against prompt injection). Source case list: `src/agents/input-guard/src/security/cases.ts`, " +
      "asserted identically by `src/agents/input-guard/src/security/prompt-injection-suite.test.ts` " +
      "(`npm test`). This report is a human-readable snapshot of the same run, not a separate claim."
  );
  lines.push("");
  lines.push(`## Summary: ${passed}/${total} cases behaved as expected`);
  lines.push("");
  lines.push("| Category | Passed | Total |");
  lines.push("|---|---|---|");
  for (const [category, { total: catTotal, passed: catPassed }] of byCategory) {
    lines.push(`| ${category} | ${catPassed} | ${catTotal} |`);
  }
  lines.push("");
  lines.push(
    "**Note on `known-gap` rows below:** these are payloads the current rule-based (regex) screen is " +
      "*expected* not to catch -- base64 encoding, full-width Unicode homoglyphs, and non-English-language " +
      "injection phrasing. They're included deliberately so this report states the screen's real coverage " +
      "boundary rather than only exercising patterns it's known to pass. `pass=true` on a `known-gap` row " +
      "means the report correctly predicted the miss, not that the attack was caught."
  );
  lines.push("");
  lines.push("## Case-by-case results");
  lines.push("");
  lines.push("| ID | Category | Description | Expected flagged | Actual flagged | Result |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.case.id} | ${row.case.category} | ${row.case.description} | ${row.case.expectedFlagged} | ${row.actualFlagged} | ${row.pass ? "PASS" : "FAIL"} |`
    );
  }
  lines.push("");

  const outDir = join(__dirname, "..", "..", "..", "..", "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "prompt-injection-report.md");
  writeFileSync(outPath, lines.join("\n"), "utf-8");

  console.log(`Wrote ${outPath} (${passed}/${total} passed)`);
  if (passed !== total) {
    console.error("One or more cases did not behave as expected -- see report for details.");
    process.exitCode = 1;
  }
}

main();
