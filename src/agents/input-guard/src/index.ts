import type { InputGuardAgentInput, InputGuardAgentOutput } from "@sage/shared-types";

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

export async function handler(input: InputGuardAgentInput): Promise<InputGuardAgentOutput> {
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

  return {
    requestId: input.requestId,
    rawInput: input.rawInput,
    sanitizedInput: sanitized,
    flagged: detected.length > 0,
    detectedPatterns: detected,
  };
}
