import { randomUUID } from "node:crypto";
import { resolveSecret } from "@sage/secrets";
import type {
  ExplainerAgentInput,
  ExplainedBlueprint,
  EscalationExplainerInput,
  EscalationExplanation,
  LlmUsage,
} from "@sage/shared-types";
import { toLlmUsage, isWarmup, WARMED } from "@sage/shared-types";
import { recordDecision, warmUp } from "@sage/audit";
import { chat } from "@sage/llm";
import { checkClaims, type ExplanationFacts } from "./claimCheck";

// Bedrock is unreachable for this AWS account (account-standing restriction on model
// access, confirmed with AWS support -- not an IAM/region issue). Calls Groq's free-tier
// API directly instead, same deviation as Intent Agent -- see its index.ts for the full
// rationale.
// llama-3.3-70b-versatile was removed from Groq's lineup since this was first written --
// confirmed via Groq's own Playground model list, which no longer has any plain Llama
// chat model (only llama-prompt-guard-2-* classifiers remain under Meta). gpt-oss-20b is
// the closer match to Claude Haiku's original small/fast/cheap profile, vs. the 120b
// variant.
const GROQ_MODEL = "openai/gpt-oss-20b";
let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (!cachedApiKey) {
    cachedApiKey = await resolveSecret("GROQ_API_KEY", "/sage/shared/GROQ_API_KEY");
  }
  return cachedApiKey;
}

// Through @sage/llm (T2.7): Groq first, OpenRouter if Groq fails or is rate-limited.
async function callModel(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<{ text: string; usage: LlmUsage | undefined }> {
  const reply = await chat({ system: systemPrompt, user: userPrompt, maxTokens, timeoutMs: 5000, fallbackTimeoutMs: 8000 });
  return { text: reply.text, usage: reply.usage };
}

const SYSTEM_PROMPT = `You are the Explainer Agent for SAGE, a cloud service marketplace.
You are given a short fact sheet about a decision. Rewrite it as a plain-language explanation
of 2-4 sentences for a non-expert. Keep every service name and every number exactly as given.
Do not add any number, service or claim that is not in the facts, and do not leave out any
service that was not chosen.
Return ONLY the explanation text, no markdown formatting, no preamble.`;

// How many times the model may try before the deterministic fact sheet is used instead.
const MAX_WORDING_ATTEMPTS = 2;

// The decision as deterministic sentences: the only source of facts for the explanation.
function buildFacts(input: ExplainerAgentInput): ExplanationFacts {
  const { composition, negotiationHistory } = input;
  const { chosen, alternatives, scoreBreakdown } = composition;
  const rejected = composition.rejected ?? [];
  const s = chosen.service;

  const parts: string[] = [
    `${s.name} was selected (price ${s.priceBasis?.startsWith("estimated") ? `about $${s.price.toFixed(2)} a month, ${s.priceBasis.replace(/^estimated USD\/month /, "")}` : `$${s.price}`}, uptime ${s.uptime}%${s.latencyMs !== undefined ? `, latency ${s.latencyMs} ms` : ""}).`,
  ];
  if (scoreBreakdown.soleSurvivor) {
    parts.push("It was the only candidate that met every requirement.");
  } else if (alternatives.length > 0) {
    parts.push(
      `It scored ${chosen.score.toFixed(3)} out of 1, ahead of ${alternatives
        .map((a) => `${a.service.name} (${a.score.toFixed(3)})`)
        .join(", ")}.`
    );
  }
  if (rejected.length > 0) {
    parts.push(`Not chosen: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}.`);
  }
  if (negotiationHistory && negotiationHistory.length > 1) {
    const earlier = negotiationHistory
      .slice(0, -1)
      .map(
        (attempt) =>
          `${attempt.composition.chosen.service.name} was rejected on attempt ${attempt.iteration} (${attempt.reviewerResult.violations
            .map((v) => `${v.constraint} was ${v.actualValue}, required ${v.requiredValue}`)
            .join("; ")})`
      )
      .join("; ");
    parts.push(`Earlier: ${earlier}.`);
  }

  return { text: parts.join(" "), chosenName: s.name, rejectedNames: rejected.map((r) => r.name) };
}

function addUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export async function handler(input: ExplainerAgentInput): Promise<ExplainedBlueprint> {
  if (isWarmup(input)) {
    await warmUp();
    return WARMED as never;
  }
  const startedAt = Date.now();
  const { composition } = input;
  const facts = buildFacts(input);

  // The model only rewords the facts. Its text is used only if it passes the claim check;
  // otherwise the deterministic fact sheet itself is the explanation.
  let explanation = facts.text;
  let explanationSource: "model" | "facts" = "facts";
  let usage: LlmUsage | undefined;
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= MAX_WORDING_ATTEMPTS; attempt++) {
    let reply: { text: string; usage: LlmUsage | undefined };
    try {
      reply = await callModel(SYSTEM_PROMPT, facts.text, 1024);
    } catch (err) {
      // No model answered: the deterministic fact sheet is a complete, faithful explanation.
      lastProblems = [`no language model answered (${err instanceof Error ? err.message : String(err)})`];
      break;
    }
    usage = addUsage(usage, reply.usage);
    const candidateText = reply.text.trim();
    lastProblems = checkClaims(candidateText, facts);
    if (lastProblems.length === 0) {
      explanation = candidateText;
      explanationSource = "model";
      break;
    }
  }

  const output: ExplainedBlueprint = {
    ...composition,
    explanation,
    explanationSource,
  };

  try {
    await recordDecision({
      durationMs: Date.now() - startedAt,
      usage,
      requestId: input.requestId,
      agent: "ExplainerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning:
        explanationSource === "model"
          ? explanation
          : `${explanation} (Plain facts used: the model's wording failed the fact check: ${lastProblems.join("; ")}.)`,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: composition.iteration,
      status: "success",
    });
  } catch (err) {
    console.error("Explainer Agent: failed to write audit record", err);
  }

  return output;
}

const ESCALATION_SYSTEM_PROMPT = `You are the Explainer Agent for SAGE, a cloud service marketplace.
A request could not be fulfilled: every candidate service tried violated at least one of the
user's constraints, and the request has been escalated to a human reviewer. Given the list of
attempted options and exactly which constraint each one violated, write a short, plain-language
explanation (3-5 sentences) for a non-technical human reviewer covering: (1) why none of the
options worked, citing the specific numbers involved, and (2) concrete options to resolve it
(e.g. raising the budget to a specific amount, lowering the uptime requirement to a specific
percentage, or broadening the request). Return ONLY the explanation text, no markdown
formatting, no preamble.`;

export async function explainEscalation(input: EscalationExplainerInput): Promise<EscalationExplanation> {
  if (isWarmup(input)) {
    await warmUp();
    return WARMED as never;
  }
  const startedAt = Date.now();
  const { attempts, constraints } = input;

  const attemptsText = attempts
    .map((attempt) => {
      const { service } = attempt.composition.chosen;
      const violations = attempt.reviewerResult.violations
        .map((v) => `${v.constraint}: actual ${v.actualValue}, required ${v.requiredValue}`)
        .join("; ");
      return `Attempt ${attempt.iteration}: ${service.name} (price: ${service.price}, uptime: ${service.uptime}%) violated: ${violations}`;
    })
    .join("\n");

  const userPrompt = `User's constraints: ${JSON.stringify(constraints)}
Attempted options and why each failed:
${attemptsText}`;

  let explanation: string;
  let usage: LlmUsage | undefined;
  try {
    ({ text: explanation, usage } = await callModel(ESCALATION_SYSTEM_PROMPT, userPrompt, 1024));
  } catch {
    // No model answered: a plain fallback still tells the user what happened.
    explanation =
      "No option met all of your requirements, so the request has been passed to a human reviewer. " +
      "Relaxing a limit such as price or uptime may let the marketplace find a match.";
  }

  const output: EscalationExplanation = {
    requestId: input.requestId,
    explanation,
    attemptedOptions: attempts.map((a) => a.composition.chosen.service),
  };

  try {
    await recordDecision({
      durationMs: Date.now() - startedAt,
      usage,
      requestId: input.requestId,
      agent: "ExplainerAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: `Escalation remediation explanation for ${attempts.length} failed attempt(s): ${explanation}`,
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: attempts.length > 0 ? attempts[attempts.length - 1].iteration : 0,
      status: "escalated",
    });
  } catch (err) {
    console.error("Explainer Agent (escalation): failed to write audit record", err);
  }

  return output;
}
