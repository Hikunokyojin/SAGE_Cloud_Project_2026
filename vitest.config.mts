import { defineConfig } from "vitest/config";

export default defineConfig({
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
