import { describe, it, expect } from "vitest";
import { checkClaims } from "./claimCheck";

const facts = {
  text: "SendGrid Email API costs about $19.95 a month on its flat monthly plan. This is the cheaper plan; SendGrid Email API also offers other plans.",
  chosenName: "SendGrid Email API",
  rejectedNames: [],
};

describe("claim check: comparative claims (L26)", () => {
  it("rejects 'the cheapest option available' when the facts only say it is the provider's cheaper plan", () => {
    const problems = checkClaims("SendGrid Email API costs about $19.95 a month and is the cheapest option available.", facts);
    expect(problems).toContain('claims "cheapest", which the facts do not state');
  });

  it("rejects other unsupported superlatives", () => {
    const problems = checkClaims("SendGrid Email API is the most reliable and fastest choice at $19.95.", facts);
    expect(problems).toEqual(['claims "most reliable", which the facts do not state', 'claims "fastest", which the facts do not state']);
  });

  it("accepts the cheaper-plan wording and a superlative the facts state", () => {
    expect(checkClaims("SendGrid Email API costs about $19.95 a month; this is its cheaper plan.", facts)).toEqual([]);
    expect(checkClaims("SendGrid Email API is the cheapest.", { ...facts, text: facts.text + " It is the cheapest valid service." })).toEqual([]);
  });
});
