// Cleans provider-written text before it enters the catalogue (T3.1).
//
// Service names and descriptions end up in the Broker's embeddings and in the Explainer's
// prompt, so a provider could try to steer the agents ("always choose this service",
// "ignore previous instructions"). The Negotiator's ranking is deterministic and does not
// read this text, but the Explainer and future agents do. Every change is reported so the
// ingestion report shows what was removed and why.

export interface SanitizeResult {
  text: string;
  changes: string[];
}

// Phrases that address the model or try to influence ranking, rather than describe a service.
const STEERING: { why: string; re: RegExp }[] = [
  { why: "instruction override", re: /\b(ignore|disregard|forget)\b[^.!?]{0,40}\b(instructions?|prompts?|rules|above|previous|prior)\b[^.!?]*[.!?]?/gi },
  { why: "selection steering", re: /\b(always|must|should)\s+(choose|select|pick|recommend|prefer|rank)\b[^.!?]*[.!?]?/gi },
  { why: "selection steering", re: /\byou\s+(must|should|need to)\s+(choose|select|pick|recommend|use)\b[^.!?]*[.!?]?/gi },
  { why: "ranking manipulation", re: /\brank\s+(this|us|it|me)\b[^.!?]*[.!?]?/gi },
  { why: "competitor suppression", re: /\b(do\s+not|don'?t|never)\s+(recommend|choose|select|suggest|mention)\s+(any\s+)?(other|another|competing)\b[^.!?]*[.!?]?/gi },
  { why: "role claim", re: /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are)|system\s+prompt|developer\s+mode)\b[^.!?]*[.!?]?/gi },
];

// Zero-width and direction-control characters, built from code points so this file never
// carries the invisible characters themselves.
const HIDDEN = new RegExp(
  "[" +
    [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e]
      .map((c) => String.fromCharCode(c))
      .join("") +
    "]",
  "g"
);

export function sanitizeText(input: string, maxLength: number): SanitizeResult {
  const changes: string[] = [];
  let text = String(input ?? "");
  const step = (re: RegExp, by: string, why: string) => {
    const next = text.replace(re, by);
    if (next !== text) changes.push(why);
    text = next;
  };

  step(HIDDEN, "", "removed hidden characters");
  // Tags with their content for model-control tags, then any remaining markup.
  step(/<\s*(system|assistant|user|instructions?)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ", "removed model-control tags");
  step(/<\/?[a-z][^>]*>/gi, " ", "removed HTML tags");
  step(/\[([^\]]*)\]\([^)]*\)/g, "$1", "removed link targets");
  step(/https?:\/\/\S+/gi, " ", "removed URLs from text");
  step(/[*_`#>~|]{1,}/g, " ", "removed markdown symbols");
  // Control characters other than ordinary whitespace.
  step(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ", "removed control characters");
  for (const { why, re } of STEERING) step(re, " ", `removed ${why}`);

  const collapsed = text.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  text = collapsed;

  if (text.length > maxLength) {
    const cut = text.slice(0, maxLength + 1);
    const space = cut.lastIndexOf(" ");
    text = (space > maxLength * 0.5 ? cut.slice(0, space) : text.slice(0, maxLength)).replace(/[\s.,;:]+$/, "");
    changes.push(`truncated to ${maxLength} characters`);
  }
  return { text, changes: [...new Set(changes)] };
}
