import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { monthlyCost, USAGE, FX_TO_USD } from "./normalise";
import type { CatalogueServiceV2 } from "./schema";

const p = (amount: number, unit: string, currency = "USD") => ({ amount, unit, currency });

describe("monthlyCost: every price becomes estimated USD per month at a stated usage", () => {
  it("per-N count units scale to the monthly volume for that kind of unit", () => {
    expect(monthlyCost(p(0.4, "per 1,000,000 requests")).usd).toBeCloseTo(0.4 * USAGE.requests / 1e6, 9);
    expect(monthlyCost(p(0.1, "per 1,000 emails")).usd).toBeCloseTo(0.1 * USAGE.emails / 1e3, 9);
    expect(monthlyCost(p(15, "per 1000000 characters")).usd).toBeCloseTo(15 * USAGE.characters / 1e6, 9);
    expect(monthlyCost(p(0.0055, "per monthly active user")).usd).toBeCloseTo(0.0055 * USAGE.users, 9);
  });
  it("subscriptions and capacity are converted to a month", () => {
    expect(monthlyCost(p(25, "per month (Pro plan)")).usd).toBe(25);
    expect(monthlyCost(p(21, "per user-month (Team)")).usd).toBe(21);
    expect(monthlyCost(p(0.62, "per cluster-hour (Development)")).usd).toBeCloseTo(0.62 * 730, 6);
    expect(monthlyCost(p(0.1666, "per registry-day")).usd).toBeCloseTo(0.1666 * 30, 6);
  });
  it("data volume uses GB stored or transferred, TB for scans", () => {
    expect(monthlyCost(p(0.023, "per GB-month")).usd).toBeCloseTo(0.023 * USAGE.gb, 9);
    expect(monthlyCost(p(6.25, "per TiB scanned")).usd).toBeCloseTo(6.25 * USAGE.tb, 9);
  });
  it("payment percentages apply to the assumed payment volume, plus any fixed fee per transaction", () => {
    const c = monthlyCost(p(2.9, "percent + $0.30 per card charge"));
    expect(c.usd).toBeCloseTo((2.9 / 100) * USAGE.paymentVolumeUsd + 0.3 * USAGE.payments, 6);
  });
  it("converts EUR and INR at the fixed rates", () => {
    expect(monthlyCost(p(29, "per month (Essential)", "EUR")).usd).toBeCloseTo(29 * FX_TO_USD.EUR, 6);
    expect(monthlyCost(p(625, "per month (Starter)", "INR")).usd).toBeCloseTo(625 * FX_TO_USD.INR, 6);
  });
  it("states the assumption in words", () => {
    expect(monthlyCost(p(0.4, "per 1,000,000 requests")).assumption).toMatch(/100,000 requests\/month/);
    // WP3.5 L9: plain wording a non-expert can read in an explanation.
    expect(monthlyCost(p(25, "per month (Pro plan)")).assumption).toBe("on its flat monthly plan");
  });
  it("throws on a unit it cannot read, so nothing is ranked on a guess", () => {
    expect(() => monthlyCost(p(1, "per flurble"))).toThrow(/unit/);
  });
});

describe("the whole real catalogue normalises", () => {
  it("every real service in data/services.v2.json has a readable unit and a finite monthly cost", () => {
    const all: CatalogueServiceV2[] = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "data", "services.v2.json"), "utf-8"));
    const failures: string[] = [];
    for (const s of all.filter((x) => !x.synthetic)) {
      try {
        const c = monthlyCost(s.pricing);
        if (!Number.isFinite(c.usd) || c.usd < 0) failures.push(`${s.serviceId}: ${c.usd}`);
      } catch (e) {
        failures.push(`${s.serviceId} "${s.pricing.unit}": ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("monthlyCost at a stated volume (T4.1b)", () => {
  const p = (amount: number, unit: string) => ({ amount, unit, currency: "USD" });
  it("prices a metered unit at the given volume instead of the fixed profile", () => {
    const c = monthlyCost(p(0.1, "per 1,000 emails"), { emails: 250_000 });
    expect(c.usd).toBeCloseTo(25, 9);
    expect(c.assumption).toBe("at 250,000 emails/month");
  });
  it("leaves a flat monthly plan unchanged", () => {
    expect(monthlyCost(p(19.95, "per month"), { emails: 250_000 }).usd).toBe(19.95);
  });
});
