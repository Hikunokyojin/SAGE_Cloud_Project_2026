import { describe, it, expect } from "vitest";
import { handler } from "../index";
import { SECURITY_CASES } from "./cases";

// Formal, dedicated security-verification artifact (Milestone 4, task 19) -- distinct
// from ../index.test.ts's ordinary unit tests. Every case here is documented (id,
// category, description) and this file's job is specifically to prove the Input
// Guard's behavior against a structured attack/benign/known-gap case list, not to
// cover incidental handler behavior. See ./cases.ts for the full case list and
// ../../../../../results/prompt-injection-report.md (generate via
// `npm run security-report --workspace=src/agents/input-guard`) for the citable,
// human-readable report this suite's results feed into.
describe("Input Guard prompt-injection verification suite", () => {
  for (const testCase of SECURITY_CASES) {
    it(`[${testCase.id}] (${testCase.category}) ${testCase.description}`, async () => {
      const result = await handler({ requestId: `security-${testCase.id}`, rawInput: testCase.payload });

      expect(result.flagged).toBe(testCase.expectedFlagged);

      if (testCase.expectedFlagged) {
        // Flagged cases must actually be neutralized, not just labeled.
        expect(result.sanitizedInput).toContain("[filtered]");
        expect(result.sanitizedInput).not.toBe(testCase.payload);
      } else {
        // Unflagged cases must pass through byte-for-byte unmodified.
        expect(result.sanitizedInput).toBe(testCase.payload);
      }
    });
  }

  it("covers at least one case per documented category", () => {
    const categories = new Set(SECURITY_CASES.map((c) => c.category));
    expect(categories).toEqual(
      new Set(["role-override", "delimiter-injection", "prompt-leak", "benign", "known-gap"])
    );
  });
});
