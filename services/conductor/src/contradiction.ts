// L30: a request that contradicts itself is not answerable as asked. Found live: "image
// resizing that is both the most expensive and the cheapest option" was parsed as a chain of
// the same step twice with no limits, so nothing downstream could reject it. Such requests go
// to a human with the contradiction stated, instead of being served.
import type { Intent } from "@sage/shared-types";

const OPPOSITES: [RegExp, RegExp, string][] = [
  [/\b(cheapest|least expensive|lowest[- ]priced?|lowest cost)\b/i, /\b(most expensive|priciest|highest[- ]priced?|highest cost)\b/i, "the cheapest and the most expensive"],
  [/\b(fastest|lowest latency)\b/i, /\b(slowest|highest latency)\b/i, "the fastest and the slowest"],
  [/\b(most reliable|highest uptime)\b/i, /\b(least reliable|lowest uptime)\b/i, "the most and the least reliable"],
];

export function contradiction(intent: Intent): string | null {
  for (const [a, b, label] of OPPOSITES) {
    if (a.test(intent.rawInput) && b.test(intent.rawInput)) return `the request asks for ${label} option at once`;
  }
  const steps = intent.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const same =
        steps[i].category === steps[j].category &&
        steps[i].capability.trim().toLowerCase() === steps[j].capability.trim().toLowerCase();
      if (same && !steps[j].dependsOn.includes(i)) {
        return `the request was read as the same step ("${steps[i].capability}") twice, which is likely a misreading`;
      }
    }
  }
  return null;
}
