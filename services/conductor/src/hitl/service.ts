// Wires the human-in-the-loop pieces together for the Conductor's routes (T2.3):
// signed review links, storing paused requests, showing one to a reviewer and applying
// the reviewer's decision. Dependencies are injected so this is unit-tested without AWS.
import type { DecisionProvenance, Intent } from "@sage/shared-types";
import type { PipelineResult } from "../pipeline";
import { signReviewToken, verifyReviewToken } from "./token";
import { resolvePaused, ResolveError, type ResolveBody, type ResolveOutcome } from "./resolve";
import type { PausedRequest, PausedStatus, Resolution } from "./store";

export interface ReviewServiceDeps {
  // Undefined when the key is not configured: pauses still work, but no link is sent.
  signingKey(): Promise<string | undefined>;
  dashboardUrl: string;
  save(p: PausedRequest): Promise<void>;
  get(requestId: string): Promise<PausedRequest | undefined>;
  markResolved(requestId: string, resolution: Resolution, status: PausedStatus): Promise<boolean>;
  record(p: DecisionProvenance): Promise<void>;
  rerun(requestId: string, intent: Intent, parentDecisionId: string): Promise<unknown>;
  now?: () => number;
}

type Paused = Extract<PipelineResult, { status: "paused_for_review" }>;

export function createReviewService(deps: ReviewServiceDeps) {
  const now = () => (deps.now ?? Date.now)();

  async function requireKey(): Promise<string> {
    const key = await deps.signingKey();
    if (!key) throw new ResolveError("Human review is not configured on this server.", 503);
    return key;
  }

  async function checkToken(requestId: string, token: string): Promise<void> {
    const key = await requireKey();
    if (!verifyReviewToken(requestId, token, key, now())) {
      throw new ResolveError("This review link is invalid or has expired.", 403);
    }
  }

  return {
    deps,

    async reviewUrl(requestId: string): Promise<string | undefined> {
      const key = await deps.signingKey();
      if (!key) return undefined;
      const token = signReviewToken(requestId, key, now());
      return `${deps.dashboardUrl}#review=${encodeURIComponent(requestId)}&token=${token}`;
    },

    async onPaused(result: Paused): Promise<void> {
      if (!result.review) return;
      await deps.save({
        requestId: result.requestId,
        status: "pending",
        reason: result.review.reason,
        intent: result.review.intent,
        candidates: result.review.candidates.map((c) => ({
          serviceId: c.serviceId,
          name: c.name,
          price: c.price,
          uptime: c.uptime,
          ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
        })),
        escalation: result.escalation,
        createdAt: new Date(now()).toISOString(),
        lastDecisionId: result.review.escalationDecisionId,
      });
    },

    async view(requestId: string, token: string): Promise<PausedRequest> {
      await checkToken(requestId, token);
      const p = await deps.get(requestId);
      if (!p) throw new ResolveError("Paused request not found.", 404);
      return p;
    },

    async resolve(requestId: string, body: ResolveBody & { token: string }): Promise<ResolveOutcome> {
      await checkToken(requestId, body?.token);
      return resolvePaused(
        {
          get: deps.get,
          markResolved: deps.markResolved,
          record: deps.record,
          rerun: (intent, parent) => deps.rerun(requestId, intent, parent),
        },
        requestId,
        body
      );
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
export { ResolveError };
