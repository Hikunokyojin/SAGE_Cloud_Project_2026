import { describe, it, expect } from "vitest";
import { awsUnitPrice, azureUnitPrice, gcpUnitPrice, parseAzureQuantity, buildRecord, PICKS, type PricePick } from ".";
import { validateService } from "../schema";

// Trimmed copies of the real response shapes (AWS offer file, Azure Retail Prices, GCP Billing Catalog).
const awsOffer = {
  products: {
    A: { attributes: { usagetype: "Requests-RBP" } },
    B: { attributes: { usagetype: "Requests-FIFO-RBP" } },
  },
  terms: {
    OnDemand: {
      A: { "A.t": { priceDimensions: {
        "A.t.free": { beginRange: "0", endRange: "1000000", unit: "Requests", pricePerUnit: { USD: "0.0000000000" }, description: "free tier" },
        "A.t.2": { beginRange: "100000000000", endRange: "Inf", unit: "Requests", pricePerUnit: { USD: "0.0000002400" }, description: "tier 3" },
        "A.t.1": { beginRange: "1000000", endRange: "100000000000", unit: "Requests", pricePerUnit: { USD: "0.0000004000" }, description: "$0.40 per million" },
      } } },
      B: { "B.t": { priceDimensions: { "B.t.1": { beginRange: "0", endRange: "Inf", unit: "Requests", pricePerUnit: { USD: "0.0000005" }, description: "fifo" } } } },
    },
  },
};

const azureItems = [
  { serviceName: "Service Bus", productName: "Service Bus", skuName: "Basic", meterName: "Basic Messaging Operations", armRegionName: "eastus", type: "Consumption", retailPrice: 0.05, unitOfMeasure: "1M", tierMinimumUnits: 0, currencyCode: "USD" },
  { serviceName: "Service Bus", productName: "Service Bus", skuName: "Basic", meterName: "Basic Messaging Operations", armRegionName: "eastus", type: "Reservation", retailPrice: 0.01, unitOfMeasure: "1M", tierMinimumUnits: 0, currencyCode: "USD" },
  { serviceName: "Service Bus", productName: "Service Bus", skuName: "Basic", meterName: "Basic Messaging Operations", armRegionName: "westus", type: "Consumption", retailPrice: 0.07, unitOfMeasure: "1M", tierMinimumUnits: 0, currencyCode: "USD" },
];

const gcpSkus = [
  { description: "Pub/Sub message delivery", pricingInfo: [{ pricingExpression: { usageUnit: "TiBy", tieredRates: [
    { startUsageAmount: 0, unitPrice: { units: "0", nanos: 0 } },
    { startUsageAmount: 0.009765625, unitPrice: { units: "40", nanos: 0 } },
  ] } }] },
];

describe("price extraction from the official feeds", () => {
  it("AWS: takes the first paid tier of the on-demand price for the exact usage type", () => {
    const p = awsUnitPrice(awsOffer, "Requests-RBP");
    expect(p?.usd).toBeCloseTo(0.0000004, 12);
    expect(p?.unit).toBe("Requests");
    expect(awsUnitPrice(awsOffer, "Requests")).toBeUndefined();
  });

  it("Azure: matches every field exactly, consumption prices only, and divides by the unit quantity", () => {
    const p = azureUnitPrice(azureItems, { serviceName: "Service Bus", productName: "Service Bus", skuName: "Basic", meterName: "Basic Messaging Operations", armRegionName: "eastus" });
    expect(p?.usd).toBeCloseTo(0.05 / 1_000_000, 14);
    expect(azureUnitPrice(azureItems, { serviceName: "Service Bus", meterName: "Nope", armRegionName: "eastus" })).toBeUndefined();
  });

  it("Azure: reads the unit quantities the API uses", () => {
    expect(parseAzureQuantity("1M")).toBe(1_000_000);
    expect(parseAzureQuantity("10K")).toBe(10_000);
    expect(parseAzureQuantity("10")).toBe(10);
    expect(parseAzureQuantity("1 GB/Month")).toBe(1);
    expect(parseAzureQuantity("100 Hours")).toBe(100);
  });

  it("GCP: takes the first paid tier and combines units and nanos", () => {
    const p = gcpUnitPrice(gcpSkus, "Pub/Sub message delivery");
    expect(p?.usd).toBe(40);
    expect(p?.unit).toBe("TiBy");
  });
});

describe("buildRecord", () => {
  const pick: PricePick = {
    provider: "aws",
    serviceId: "svc-aws-sqs",
    name: "Amazon SQS",
    description: "Fully managed message queue for decoupling services.",
    capability: "message-queue",
    endpoint: "https://sqs.us-east-1.amazonaws.com",
    unit: "per 1,000,000 requests",
    scale: 1_000_000,
    uptime: 99.9,
    slaUrl: "https://aws.amazon.com/messaging/sla/",
    match: { offer: "AWSQueueService", usagetype: "Requests-RBP" },
  };

  it("produces a valid v2 record with the scaled price and its sources", () => {
    const r = buildRecord(pick, { usd: 0.0000004, unit: "Requests", description: "$0.40 per million" }, "https://pricing.example/offer.json", "2026-11-11");
    expect(r.pricing).toEqual({ amount: 0.4, unit: "per 1,000,000 requests", currency: "USD", notes: expect.stringContaining("$0.40 per million") });
    expect(r.source.url).toBe("https://pricing.example/offer.json");
    expect(r.source.terms).toContain("https://aws.amazon.com/messaging/sla/");
    expect(r.synthetic).toBeUndefined();
    expect(validateService(r)).toEqual([]);
  });

  it("rounds away floating-point noise", () => {
    const r = buildRecord({ ...pick, scale: 1000 }, { usd: 0.0000071, unit: "x", description: "" }, "https://p.example", "2026-11-11");
    expect(r.pricing.amount).toBe(0.0071);
  });
});

describe("PICKS", () => {
  it("every configured pick builds a valid record and ids are unique", () => {
    const ids = new Set<string>();
    for (const p of PICKS) {
      expect(ids.has(p.serviceId), p.serviceId).toBe(false);
      ids.add(p.serviceId);
      const r = buildRecord(p, { usd: 0.001, unit: "u", description: "d" }, "https://p.example", "2026-11-11");
      expect(validateService(r), p.serviceId).toEqual([]);
    }
  });
});
