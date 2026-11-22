// T4.1a: defensive parsing of the model's multi-step output, volumes and per-unit limits.
// The model can return anything; only well-formed pieces survive.
import { SERVICE_CATEGORIES, USAGE_UNITS } from "@sage/shared-types";
import type { Constraint, ConstraintOperator, IntentStep, UsageUnit, UsageVolume } from "@sage/shared-types";

const VALID_FIELDS = new Set(["price", "uptime", "latencyMs"]);
const VALID_OPERATORS: ConstraintOperator[] = ["lt", "lte", "gt", "gte", "eq"];
export const MAX_STEPS = 4;

// Only an exact catalog category is accepted; anything else (including "unknown")
// means no category filter downstream, rather than filtering on a guess.
export function normalizeCategory(raw: unknown): string | undefined {
  return typeof raw === "string" && (SERVICE_CATEGORIES as readonly string[]).includes(raw) ? raw : undefined;
}

// Strictly-typed Constraint[] from whatever the model produced.
export function normalizeConstraints(raw: unknown): Constraint[] {
  if (!Array.isArray(raw)) return [];
  const result: Constraint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.field !== "string" || !VALID_FIELDS.has(e.field)) continue;
    if (typeof e.operator !== "string" || !VALID_OPERATORS.includes(e.operator as ConstraintOperator)) continue;
    if (typeof e.value !== "number" || Number.isNaN(e.value)) continue;
    const mandatory = e.mandatory === true;
    const constraint: Constraint = { field: e.field, operator: e.operator as ConstraintOperator, value: e.value, mandatory };
    if (!mandatory) constraint.priority = typeof e.priority === "number" && !Number.isNaN(e.priority) ? e.priority : 5;
    if (e.field === "price" && e.per === "unit") constraint.per = "unit";
    result.push(constraint);
  }
  return result;
}

export function normalizeVolume(raw: unknown): UsageVolume | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { amount, unit } = raw as Record<string, unknown>;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return undefined;
  if (typeof unit !== "string" || !(USAGE_UNITS as readonly string[]).includes(unit)) return undefined;
  return { amount, unit: unit as UsageUnit };
}

// L2: "under $0.05 per image" at 10,000 images a month is "under $500 a month", the unit
// every candidate's price is in. Without a volume the limit keeps its per-unit flag.
export function applyVolume(constraints: Constraint[], volume: UsageVolume | undefined): Constraint[] {
  if (!volume) return constraints;
  return constraints.map((c) => {
    if (c.per !== "unit") return c;
    const { per: _per, ...rest } = c;
    return { ...rest, value: Math.round(c.value * volume.amount * 1e6) / 1e6 };
  });
}

// Two to four steps, or undefined so a single-capability request keeps today's shape.
export function normalizeSteps(raw: unknown): IntentStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: IntentStep[] = [];
  for (const entry of raw.slice(0, MAX_STEPS)) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const e = entry as Record<string, unknown>;
    if (typeof e.capability !== "string" || e.capability.trim() === "") return undefined;
    const index = steps.length;
    const volume = normalizeVolume(e.volume);
    const step: IntentStep = {
      capability: e.capability,
      category: normalizeCategory(e.category),
      constraints: applyVolume(normalizeConstraints(e.constraints), volume),
      dependsOn: Array.isArray(e.dependsOn)
        ? [...new Set(e.dependsOn.filter((d): d is number => Number.isInteger(d) && d >= 0 && d < index))]
        : [],
    };
    if (step.category === undefined) delete step.category;
    if (volume) step.volume = volume;
    steps.push(step);
  }
  return steps.length >= 2 ? steps : undefined;
}
