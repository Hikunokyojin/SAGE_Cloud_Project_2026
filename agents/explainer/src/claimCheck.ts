// Checks that a model-written explanation says nothing the facts do not support.
//
// The Explainer gives the language model a short fact sheet built deterministically from the
// decision, and asks it only to reword it. This check is the guard rail: if the wording adds a
// number, leaves out a service the user should know about, or claims there were no
// alternatives when candidates were rejected, the wording is not used.

export interface ExplanationFacts {
  // The deterministic fact sheet; every number allowed in the explanation appears here.
  text: string;
  chosenName: string;
  // T4.1e: the services chosen for the other steps of a chain; each must be named too.
  alsoChosen?: string[];
  rejectedNames: string[];
  // The cheaper-plan sentence, when the chosen plan is the provider's cheaper one (T4.1b).
  cheaperPlan?: string;
}

const NUMBER = /\d+(?:\.\d+)?/g;

function numbersIn(text: string): number[] {
  return (text.match(NUMBER) ?? []).map(Number);
}

// Returns a list of problems; an empty list means the text is faithful to the facts.
export function checkClaims(text: string, facts: ExplanationFacts): string[] {
  const problems: string[] = [];

  const allowed = numbersIn(facts.text);
  for (const n of numbersIn(text)) {
    if (!allowed.some((a) => Math.abs(a - n) < 1e-9)) {
      problems.push(`number ${n} does not appear in the facts`);
    }
  }

  const lower = text.toLowerCase();
  if (!lower.includes(facts.chosenName.toLowerCase())) {
    problems.push(`chosen service ${facts.chosenName} is not named`);
  }
  for (const name of facts.alsoChosen ?? []) {
    if (!lower.includes(name.toLowerCase())) {
      problems.push(`chosen service ${name} is not named`);
    }
  }
  for (const name of facts.rejectedNames) {
    if (!lower.includes(name.toLowerCase())) {
      problems.push(`rejected candidate ${name} is not named`);
    }
  }

  if (facts.rejectedNames.length > 0 && /\bno (?:other )?alternatives?\b|\bno other options?\b/i.test(text)) {
    problems.push("claims there were no alternatives, but some candidates were rejected");
  }

  return problems;
}
