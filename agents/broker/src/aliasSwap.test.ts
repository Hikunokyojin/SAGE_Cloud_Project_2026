import { describe, it, expect } from "vitest";
import { planAliasSwap } from "./aliasSwap";

// WP3.5 L8: re-embedding builds a new collection and moves the "services" alias to it,
// so the Broker's searches never see an empty or half-filled index.

describe("planAliasSwap", () => {
  it("moves the alias in one step and drops the collection it used to point to", () => {
    const plan = planAliasSwap({ alias: "services", fresh: "services_2", collections: ["services_1", "services_2"], aliasTarget: "services_1" });
    expect(plan.actions).toEqual([
      { delete_alias: { alias_name: "services" } },
      { create_alias: { collection_name: "services_2", alias_name: "services" } },
    ]);
    expect(plan.dropBefore).toEqual([]);
    expect(plan.dropAfter).toEqual(["services_1"]);
  });

  it("first run: a plain collection still holds the alias name, so it must go before the alias can exist", () => {
    const plan = planAliasSwap({ alias: "services", fresh: "services_2", collections: ["services", "services_2"], aliasTarget: undefined });
    expect(plan.dropBefore).toEqual(["services"]);
    expect(plan.actions).toEqual([{ create_alias: { collection_name: "services_2", alias_name: "services" } }]);
    expect(plan.dropAfter).toEqual([]);
  });

  it("also cleans up older leftover generations, never the fresh one", () => {
    const plan = planAliasSwap({ alias: "services", fresh: "services_3", collections: ["services_1", "services_2", "services_3", "audit"], aliasTarget: "services_2" });
    expect(plan.dropAfter.sort()).toEqual(["services_1", "services_2"]);
  });
});
