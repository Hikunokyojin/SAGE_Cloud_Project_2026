// T4.5: fault injection for the Reviewer. Each fault is a plausible Negotiator bug applied to a
// real catalogue service; the Reviewer must reject the corrupted composition. Pure: no I/O.
import type { Composition, Constraint, ReviewerAgentInput, Service } from "@sage/shared-types";

export type FaultKind =
  | "off-by-one-price"
  | "off-by-one-uptime"
  | "wrong-unit-price"
  | "stale-price"
  | "wrong-category"
  | "stale-uptime"
  | "stale-list-price";

export interface Fault {
  id: string;
  kind: FaultKind;
  serviceId: string;
  description: string;
  input: ReviewerAgentInput;
}

function composition(service: Service): Composition {
  return {
    requestId: "t45",
    chosen: { service, score: 0.9, reason: "fault injection" },
    alternatives: [],
    iteration: 1,
    scoreBreakdown: {
      requestId: "t45",
      candidateId: service.serviceId,
      dimensions: {},
      weights: {},
      totalScore: 0.9,
      // The faulty Negotiator always claims the pick passed.
      constraintStatus: "pass",
      violatedConstraints: [],
    },
  } as unknown as Composition;
}

function input(service: Service, constraints: Constraint[], requiredCategory: string): ReviewerAgentInput {
  return { requestId: "t45", composition: composition(service), constraints, requiredCategory };
}

const mandatory = (field: Constraint["field"], operator: Constraint["operator"], value: number): Constraint =>
  ({ field, operator, value, mandatory: true }) as Constraint;

/**
 * Builds the faults for one correct service (price already the honest monthly figure).
 * Every fault describes a pick the request should NOT get, so "approved" is a miss.
 */
export function faultsFor(s: Service): Fault[] {
  const cat = s.capability ?? "";
  const out: Fault[] = [];
  const add = (kind: FaultKind, description: string, inp: ReviewerAgentInput) =>
    out.push({ id: `${kind}:${s.serviceId}`, kind, serviceId: s.serviceId, description, input: inp });

  // Off-by-one thresholds: the limit sits just past the true value and the Negotiator lets it through.
  if (s.price > 0.01) {
    add("off-by-one-price", `limit "price under ${s.price}" (lt) passed by a <= check`, input(s, [mandatory("price", "lt", s.price)], cat));
  }
  add("off-by-one-uptime", `limit "uptime above ${s.uptime}" (gt) passed by a >= check`, input(s, [mandatory("uptime", "gt", s.uptime)], cat));

  // Wrong unit: the list amount (e.g. per 1,000 emails) reported as the monthly price, under a limit it would then meet.
  if (typeof s.listPrice === "number" && s.price - s.listPrice > 0.01) {
    add("wrong-unit-price", `list amount ${s.listPrice} ${s.priceUnit} reported as ${s.listPrice}/month`, input({ ...s, price: s.listPrice }, [mandatory("price", "lte", s.listPrice)], cat));
  }

  // Stale price: an older, 20% lower price kept by the Negotiator, which now meets a limit the real price breaks.
  if (s.price > 0.05) {
    const stale = Math.round(s.price * 0.8 * 100) / 100;
    add("stale-price", `stale price ${stale} instead of ${s.price}`, input({ ...s, price: stale }, [mandatory("price", "lte", stale)], cat));
  }

  // Wrong category: the right service object, offered for a category it is not in.
  const other = cat === "email-delivery" ? "object-storage" : "email-delivery";
  add("wrong-category", `${cat} service offered for ${other}`, input(s, [], other));

  // Stale uptime: an inflated uptime figure carried over. The Reviewer has no second source for uptime.
  if (s.uptime < 99.99) {
    add("stale-uptime", `uptime ${s.uptime} reported as 99.99`, input({ ...s, uptime: 99.99 }, [mandatory("uptime", "gte", 99.99)], cat));
  }

  // Stale list price: both the list price and the monthly price stale together (consistent but wrong).
  if (typeof s.listPrice === "number" && s.price > 0.05) {
    const stale = Math.round(s.price * 0.8 * 100) / 100;
    const ratio = stale / s.price;
    add("stale-list-price", `list price and monthly price both 20% low`, input({ ...s, price: stale, listPrice: s.listPrice * ratio }, [mandatory("price", "lte", stale)], cat));
  }
  return out;
}

export interface FaultOutcome {
  fault: Fault;
  caught: boolean;
  violations: string[];
}

export function summarise(outcomes: FaultOutcome[]) {
  const byKind = new Map<FaultKind, { injected: number; caught: number }>();
  for (const o of outcomes) {
    const k = byKind.get(o.fault.kind) ?? { injected: 0, caught: 0 };
    k.injected++;
    if (o.caught) k.caught++;
    byKind.set(o.fault.kind, k);
  }
  const injected = outcomes.length;
  const caught = outcomes.filter((o) => o.caught).length;
  return { injected, caught, rate: injected ? caught / injected : 0, byKind: Object.fromEntries(byKind) };
}
