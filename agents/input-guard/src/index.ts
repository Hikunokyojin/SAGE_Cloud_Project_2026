import { randomUUID } from "node:crypto";
import type { InputGuardAgentInput, InputGuardAgentOutput } from "@sage/shared-types";
import { recordDecision, warmUp } from "@sage/audit";
import { isWarmup, WARMED } from "@sage/shared-types";

// Rule-based (not Bedrock-backed) prompt-injection screen: fast, free, deterministic,
// and runs before any LLM-facing agent sees the request. On a match, the offending
// phrase is replaced with "[filtered]" and the request continues (sanitize-and-continue),
// rather than rejecting the whole request outright.
interface PatternCategory {
  name: string;
  patterns: RegExp[];
}

const CATEGORIES: PatternCategory[] = [
  {
    name: "role-override",
    patterns: [
      /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?/gi,
      /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)(\s+instructions?)?/gi,
      /forget\s+(everything\s+)?(above|previous|prior)/gi,
      /new\s+instructions?\s*:/gi,
      /you\s+are\s+now\s+(in\s+)?(developer|admin|god)\s*mode/gi,
      /developer\s+mode/gi,
      /act\s+as\s+if\s+you/gi,
      /pretend\s+(that\s+)?you\s+are/gi,
    ],
  },
  {
    name: "delimiter-injection",
    patterns: [
      /<\/?(system|assistant|user)>/gi,
      /<\|im_start\|>/gi,
      /<\|im_end\|>/gi,
      /\[\/?inst\]/gi,
      /###\s*instruction/gi,
    ],
  },
  {
    name: "prompt-leak",
    patterns: [
      /reveal\s+(your\s+)?system\s+prompt/gi,
      /(print|show|repeat|output)\s+(your\s+)?(system\s+prompt|instructions)/gi,
      /repeat\s+the\s+instructions\s+above/gi,
      /what\s+(are|is)\s+your\s+(system\s+)?instructions/gi,
    ],
  },
];

// L29: requests for a harmful purpose are refused outright rather than served. Each pattern
// needs the harmful aim itself (not a word like "phishing" or "track" on its own), so
// "detect phishing emails" or "track sign-ups in analytics" still go through.
const MISUSE: { category: string; reason: string; pattern: RegExp }[] = [
  {
    category: "data-exfiltration",
    reason: "it asks for system data or secrets to be sent to an outside address",
    pattern: /\b(email|send|forward|post|upload|exfiltrate)\b[^.]{0,60}\b(audit (table|trail|log)s?|api keys?|secrets?|credentials|passwords)\b[^.]{0,40}\bto\b[^.]{0,20}(@|https?:\/\/)/i,
  },
  {
    category: "spam",
    reason: "it asks to send unsolicited bulk messages",
    pattern: /\b(unsolicited|spam)\b|\b(bought|purchased|scraped|rented)\s+(phone|email|contact|mailing)\s+lists?\b/i,
  },
  {
    category: "phishing",
    reason: "it asks for messages that impersonate another organisation to deceive people",
    pattern: /\b(send|create|write|run)\b[^.]{0,30}\bphishing\b|\b(look|looks|appear)\s+(like|to be from)\s+(a|an|the|their)\s+(bank|government|tax office|paypal|microsoft|apple)\b|\bimpersonat(e|ing)\b/i,
  },
  {
    category: "covert-tracking",
    reason: "it asks to track or watch a person without their knowledge or consent",
    pattern: /\b(track|follow|monitor|spy on|locate)\b[^.]{0,60}\bwithout\s+(them|him|her|their)\s+(knowing|knowledge|consent)\b|\b(stalk|stalking|spy on (my|an?|her|his|their))\b/i,
  },
  {
    category: "unauthorised-compute",
    reason: "it asks to use other people's accounts or machines without permission",
    pattern: /\b(mine|mining)\b[^.]{0,30}\bcrypto[a-z]*\b[^.]{0,40}\b(other people'?s|someone else'?s|without (their )?permission|stolen)\b|\bcryptojack|\bbotnet\b|\bddos\b|\bransomware\b/i,
  },
  {
    category: "personal-data-scraping",
    reason: "it asks to collect people's personal data without consent",
    pattern: /\bscrap(e|ing)\b[^.]{0,60}\b(personal data|personal information|everyone'?s)\b/i,
  },
];

export function misuse(text: string): { category: string; reason: string } | undefined {
  const hit = MISUSE.find((m) => m.pattern.test(text));
  return hit ? { category: hit.category, reason: `This request was refused because ${hit.reason}.` } : undefined;
}

export async function handler(input: InputGuardAgentInput): Promise<InputGuardAgentOutput> {
  if (isWarmup(input)) {
    await warmUp();
    return WARMED as never;
  }
  const startedAt = Date.now();
  let sanitized = input.rawInput;
  const detected: string[] = [];

  for (const category of CATEGORIES) {
    let matchedInCategory = false;
    for (const pattern of category.patterns) {
      if (pattern.test(sanitized)) {
        matchedInCategory = true;
      }
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, "[filtered]");
      pattern.lastIndex = 0;
    }
    if (matchedInCategory) {
      detected.push(category.name);
    }
  }

  const refused = misuse(input.rawInput);
  if (refused) detected.push(refused.category);

  const output: InputGuardAgentOutput = {
    requestId: input.requestId,
    rawInput: input.rawInput,
    sanitizedInput: sanitized,
    flagged: detected.length > 0,
    detectedPatterns: detected,
    ...(refused ? { refused } : {}),
  };

  // Audit-trail write is best-effort: a DynamoDB hiccup shouldn't block the pipeline,
  // it should just leave a gap in the trail for that step.
  try {
    await recordDecision({
      durationMs: Date.now() - startedAt,
      requestId: input.requestId,
      agent: "InputGuardAgent",
      timestamp: new Date().toISOString(),
      input,
      output,
      reasoning: refused
        ? `Refused (${refused.category}): ${refused.reason}`
        : output.flagged
        ? `Flagged and sanitized categories: ${output.detectedPatterns.join(", ")}`
        : "No prompt-injection patterns detected.",
      decisionId: input.decisionId ?? randomUUID(),
      parentDecisionId: input.parentDecisionId,
      iteration: 0,
      status: "success",
    });
  } catch (err) {
    console.error("Input Guard Agent: failed to write audit record", err);
  }

  return output;
}
