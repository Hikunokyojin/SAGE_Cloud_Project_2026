import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Tests load @sage/llm from source: its compiled CommonJS require() of @sage/secrets would
  // bypass a test's vi.mock() and could reach real SSM from a unit test.
  resolve: {
    alias: { "@sage/llm": fileURLToPath(new URL("./packages/llm/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**"],
    // CDK's Template.fromStack() runs a full synth per test (reads Lambda asset
    // bundles from disk, resolves SSM AMI lookups) -- slower than the mocked unit
    // tests elsewhere, so the default 5s timeout is too tight under load.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["**/src/**/*.ts", "**/lib/**/*.ts"],
      exclude: ["**/*.test.ts", "**/local-test.ts", "**/node_modules/**", "**/dist/**", "**/cdk.out/**"],
    },
  },
});
