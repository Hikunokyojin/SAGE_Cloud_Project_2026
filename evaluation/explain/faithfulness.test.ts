import { describe, it, expect } from "vitest";
import { checkFaithfulness, numbersIn } from "./faithfulness";

const svc = (name: string, price: number, uptime: number, latencyMs: number, extra: object = {}) => ({
  service: { name, price, uptime, latencyMs, similarityScore: 0.4763, ...extra },
  score: 0.9252,
});
const input = {
  composition: {
    chosen: svc("Cloudflare Images", 5, 100, 375, { priceBasis: "estimated USD/month at 10,000 images/month" }),
    alternatives: [svc("ImageKit", 9, 99.908, 786)],
    rejected: [{ name: "Imgix", reason: "price above the limit" }],
    scoreBreakdown: { totalScore: 0.9252, weights: { price: 3 } },
  },
};

describe("checkFaithfulness (T4.6)", () => {
  it("reads numbers with thousands separators", () => {
    expect(numbersIn("up to 10,000 images at $5.00")).toEqual([10000, 5]);
    expect(numbersIn("10 000 images, 100 GB, 1089 ms")).toEqual([10000, 100, 1089]);
  });

  it("accepts text whose numbers all come from the decision, rounded or not", () => {
    const text = "Cloudflare Images costs about $5.00 a month for 10,000 images, 100% uptime, 375 ms. ImageKit (99.91%) was ranked lower; Imgix was over the price limit.";
    expect(checkFaithfulness(text, input)).toEqual({ faithful: true, problems: [], scoreLeak: false });
  });

  it("flags an invented number", () => {
    const r = checkFaithfulness("Cloudflare Images costs $4 and beat ImageKit and Imgix.", input);
    expect(r.problems).toContain("number 4 is not in the decision");
  });

  it("flags an internal ranking score shown to the client", () => {
    const r = checkFaithfulness("Cloudflare Images scored 0.925, ahead of ImageKit; Imgix was rejected.", input);
    expect(r.scoreLeak).toBe(true);
    expect(r.faithful).toBe(false);
  });

  it("flags a missing rejected candidate and a false 'no alternatives' claim", () => {
    const r = checkFaithfulness("Cloudflare Images was chosen. There were no alternatives.", input);
    expect(r.problems).toEqual([
      "rejected candidate Imgix is not named",
      "claims there were no alternatives, but there were",
    ]);
  });

  it("requires every attempted service to be named in an escalation", () => {
    const r = checkFaithfulness("No option met your limits.", {
      attempts: [{ composition: { chosen: { service: { name: "MailRelay" } } } }],
    });
    expect(r.problems).toEqual(["attempted service MailRelay is not named"]);
  });
});

import { summariseRatings } from "./ratings";
describe("summariseRatings (T4.6)", () => {
  it("averages each scale across raters and items", () => {
    const s = summariseRatings([{ a: { clarity: 5, correctness: 4 } }, { a: { clarity: 3, correctness: 4 }, b: { clarity: 4 } }]);
    expect(s.raters).toBe(2);
    expect(s.clarity).toEqual({ n: 3, mean: 4, min: 3, max: 5 });
    expect(s.correctness.mean).toBe(4);
  });
});
