// What a human reviewer can do with a paused request (T2.3):
//   approve: accept one of the services that were offered (the candidates the
//            pipeline retrieved), overriding the automatic verdict;
//   reject:  close the request, with a note;
//   relax:   edit the constraints and re-run the pipeline from the edited intent.
// Every decision is written to the audit trail as a HumanInTheLoop provenance record
// that links to the escalation it answers.
import { randomUUID } from "node:crypto";
import type { Constraint, DecisionProvenance, Intent } from "@sage/shared-types";
import type { PausedRequest, PausedStatus, Resolution } from "./store";

export interface ResolveBody {
  action: "approve" | "reject" | "relax";
  reviewer: string;
  note?: string;
  serviceId?: string;
  constraints?: Constraint[];
}

export interface ResolveDeps {
  get(requestId: string): Promise<PausedRequest | undefined>;
  markResolved(requestId: string, resolution: Resolution, status: PausedStatus): Promise<boolean>;
  record(p: DecisionProvenance): Promise<void>;
  // Re-runs the pipeline from Broker onward; the second argument is the human decision's id.
  rerun(intent: Intent, parentDecisionId: string): Promise<unknown>;
  now?: () => string;
}

export interface ResolveOutcome {
  requestId: string;
  status: PausedStatus;
  resolution: Resolution;
  result?: unknown;
}

export class ResolveError extends Error {
  constructor(message: string, public readonly httpStatus: number) {
    super(message);
  }
}

const FIELDS = new Set(["price", "uptime", "latencyMs"]);
const OPS = new Set(["lt", "lte", "gt", "gte", "eq"]);

// The browser is not trusted: only well-formed constraints survive.
export function cleanConstraints(raw: unknown): Constraint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is Constraint =>
        !!c &&
        typeof c === "object" &&
        FIELDS.has((c as Constraint).field) &&
        OPS.has((c as Constraint).operator) &&
        typeof (c as Constraint).value === "number" &&
        Number.isFinite((c as Constraint).value)
    )
    .map((c) => ({
      field: c.field,
      operator: c.operator,
      value: c.value,
      mandatory: c.mandatory === true,
      ...(typeof c.priority === "number" ? { priority: c.priority } : {}),
    }));
}

const STATUS: Record<ResolveBody["action"], PausedStatus> = { approve: "approved", reject: "rejected", relax: "rerun" };

export async function resolvePaused(deps: ResolveDeps, requestId: string, body: ResolveBody): Promise<ResolveOutcome> {
  if (!body || !Object.prototype.hasOwnProperty.call(STATUS, body.action)) {
    throw new ResolveError("Unknown action; use approve, reject or relax.", 400);
  }
  const reviewer = String(body.reviewer ?? "").trim().slice(0, 100);
  if (!reviewer) throw new ResolveError("Reviewer name is required.", 400);
  const note = body.note ? String(body.note).slice(0, 1000) : undefined;

  const paused = await deps.get(requestId);
  if (!paused) throw new ResolveError("Paused request not found.", 404);
  if (paused.status !== "pending") throw new ResolveError(`This request was already resolved (${paused.status}).`, 409);

  if (body.action === "approve" && !paused.candidates.some((c) => c.serviceId === body.serviceId)) {
    throw new ResolveError("That service is not one of the services offered for this request.", 400);
  }
  const constraints = body.action === "relax" ? cleanConstraints(body.constraints) : undefined;

  const resolution: Resolution = {
    action: body.action,
    reviewer,
    ...(note ? { note } : {}),
    ...(body.action === "approve" ? { serviceId: body.serviceId } : {}),
    ...(constraints ? { constraints } : {}),
    resolvedAt: (deps.now ?? (() => new Date().toISOString()))(),
    decisionId: randomUUID(),
  };
  const status = STATUS[body.action];

  if (!(await deps.markResolved(requestId, resolution, status))) {
    throw new ResolveError("This request was already resolved by someone else.", 409);
  }

  const noteText = note ? ` Note: ${note}` : "";
  await deps.record({
    requestId,
    agent: "HumanInTheLoop",
    timestamp: resolution.resolvedAt,
    input: {
      reason: paused.reason,
      offered: paused.candidates.map((c) => c.serviceId),
      constraints: paused.intent.constraints,
    },
    output: resolution,
    reasoning:
      body.action === "approve"
        ? `Human reviewer ${reviewer} approved ${body.serviceId}.${noteText}`
        : body.action === "reject"
          ? `Human reviewer ${reviewer} rejected the request.${noteText}`
          : `Human reviewer ${reviewer} relaxed the constraints to ${JSON.stringify(constraints)} and re-ran the pipeline.${noteText}`,
    decisionId: resolution.decisionId,
    parentDecisionId: paused.lastDecisionId,
    iteration: 0,
    status: "success",
  });

  if (body.action === "relax") {
    const result = await deps.rerun({ ...paused.intent, constraints: constraints! }, resolution.decisionId);
    return { requestId, status, resolution, result };
  }
  return { requestId, status, resolution };
}
