// Ground truth for CSR/CVR: for each test case, the capability the request asks for
// and the mandatory constraints its own wording states ("under $0.05", "at least
// 99.5% uptime"). Superlatives ("cheapest", "fastest") are preferences, not
// constraints -- whether the best option was picked is Selection Accuracy's job.
//
// A chosen service satisfies the request iff it is in the requested capability and
// meets every mandatory constraint, checked against the real catalog values. This is
// independent of any condition's own verdict and of what Intent extracted.

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Field = "price" | "uptime" | "latencyMs";
type Op = "lt" | "lte" | "gt" | "gte" | "eq";
export interface GroundTruth {
  capability: string;
  constraints: Array<[Field, Op, number]>;
}

export const GROUND_TRUTH: Record<string, GroundTruth> = {
  "SS-1": { capability: "email-delivery", constraints: [] },
  "SS-2": { capability: "authentication", constraints: [] },
  "SS-3": { capability: "geolocation", constraints: [] },
  "CO-1": { capability: "image-resizing", constraints: [] },
  "CO-2": { capability: "object-storage", constraints: [] },
  "CO-3": { capability: "compute", constraints: [] },
  "CO-4": { capability: "full-text-search", constraints: [] },
  "PO-1": { capability: "image-resizing", constraints: [] },
  "PO-2": { capability: "object-storage", constraints: [] },
  "PO-3": { capability: "compute", constraints: [] },
  "PO-4": { capability: "message-queue", constraints: [] },
  "RO-1": { capability: "compute", constraints: [["uptime", "gte", 99.9]] },
  "RO-2": { capability: "object-storage", constraints: [["uptime", "gte", 99.5]] },
  "RO-3": { capability: "image-resizing", constraints: [["uptime", "gte", 99.8]] },
  "MC-1": { capability: "image-resizing", constraints: [["price", "lt", 0.05], ["uptime", "gte", 99.5], ["latencyMs", "lt", 100]] },
  "MC-2": { capability: "compute", constraints: [["price", "lt", 0.15], ["uptime", "gte", 99], ["latencyMs", "lt", 500]] },
  "MC-3": { capability: "object-storage", constraints: [["price", "lt", 0.03], ["uptime", "gte", 99.9], ["latencyMs", "lt", 100]] },
  "MC-4": { capability: "document-generation", constraints: [["price", "lt", 0.02], ["uptime", "gte", 98]] },
  "CV-1": { capability: "image-resizing", constraints: [["price", "lt", 0.01], ["latencyMs", "lt", 50]] },
  "CV-2": { capability: "compute", constraints: [["price", "lt", 0.01], ["uptime", "gte", 99]] },
  "RN-1": { capability: "image-resizing", constraints: [["price", "lt", 0.05], ["uptime", "gte", 99]] },
  "RN-2": { capability: "object-storage", constraints: [["price", "lt", 0.03], ["uptime", "gte", 99.5]] },
  "NVS-1": { capability: "image-resizing", constraints: [["uptime", "gte", 100]] },
  "NVS-2": { capability: "object-storage", constraints: [["latencyMs", "lt", 10]] },
  "NVS-3": { capability: "compute", constraints: [["price", "lt", 0.001]] },
  "HITL-1": { capability: "email-delivery", constraints: [["price", "lt", 0.0001], ["uptime", "gte", 99.99]] },
  "HITL-2": { capability: "messaging", constraints: [["price", "lt", 0.001], ["latencyMs", "lt", 10]] },
};

interface CatalogService {
  serviceId: string;
  capability: string;
  price: number;
  uptime: number;
  latencyMs?: number;
}

const CATALOG: CatalogService[] = (() => {
  const raw = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dataset", "services.json"), "utf-8"));
  return Array.isArray(raw) ? raw : raw.services;
})();

function holds(actual: number, op: Op, value: number): boolean {
  switch (op) {
    case "lt": return actual < value;
    case "lte": return actual <= value;
    case "gt": return actual > value;
    case "gte": return actual >= value;
    case "eq": return actual === value;
  }
}

/** Whether `serviceId` is a valid answer to test case `testCaseId`; false for unknown services. */
export function satisfiesRequest(testCaseId: string, serviceId: string | undefined): boolean {
  const truth = GROUND_TRUTH[testCaseId];
  if (!truth) throw new Error(`no ground truth for test case ${testCaseId}`);
  const service = CATALOG.find((s) => s.serviceId === serviceId);
  if (!service || service.capability !== truth.capability) return false;
  return truth.constraints.every(([field, op, value]) => {
    const actual = service[field];
    return actual !== undefined && holds(actual, op, value);
  });
}
