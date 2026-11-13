// Comparable prices (T3.4). Providers price in different units (per month, per 1,000 requests,
// per GB, percent of a payment, per audio minute...). The Negotiator ranks on one number, so
// every listed price is converted to an ESTIMATED US DOLLARS PER MONTH at a stated, fixed
// usage profile. The profile is an assumption, deliberately simple and documented (and the
// Explainer can show it); it makes services comparable, not exact bills.

// Monthly usage assumed for each kind of unit.
export const USAGE = {
  requests: 100_000, // API calls, queries, operations, messages, predictions...
  emails: 100_000,
  sms: 10_000,
  characters: 1_000_000,
  tokens: 10_000_000,
  pages: 10_000, // documents, pages, forms, invoices
  images: 10_000,
  users: 1_000, // monthly active / retained users
  events: 1_000_000, // analytics events, traces, metric samples, ingress events
  minutes: 1_000, // audio or video minutes
  gb: 100, // stored, transferred or ingested
  tb: 1, // scanned
  gbSeconds: 400_000, // serverless memory-time
  cpuSeconds: 100_000,
  payments: 200, // card transactions...
  paymentVolumeUsd: 10_000, // ...totalling this much
  hours: 730, // an always-on hour-billed resource
  days: 30,
} as const;

// Fixed reference rates (2026-11-12), so rankings do not move with daily FX.
export const FX_TO_USD: Record<string, number> = { USD: 1, EUR: 1.08, INR: 0.012 };

export interface MonthlyCost {
  usd: number;
  assumption: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

// Count nouns to usage kinds; first match wins.
const KINDS: [RegExp, keyof typeof USAGE, string][] = [
  [/character/, "characters", "characters"],
  [/token/, "tokens", "tokens"],
  [/email/, "emails", "emails"],
  [/\bsms\b|sms (part|segment)|outbound sms/, "sms", "SMS"],
  [/active user|retained user/, "users", "monthly active users"],
  [/image|transformation/, "images", "images"],
  [/page|pdf|invoice|document write/, "pages", "pages"],
  [/screened transaction/, "payments", "transactions"],
  [/event|trace|metric sample|text record/, "events", "events"],
  [/minutes? stored/, "minutes", "minutes"],
  [/request|call|quer|operation|transaction|message|push|execution|action|step|transition|prediction|command|unit|write/, "requests", "requests"],
];

// `usage` overrides the fixed profile for some kinds, for example the volume a request states
// (T4.1b, L3): monthlyCost(pricing, { emails: 250_000 }).
export function monthlyCost(
  pricing: { amount: number; unit: string; currency: string },
  usage: Partial<Record<keyof typeof USAGE, number>> = {}
): MonthlyCost {
  const U = { ...USAGE, ...usage };
  const fx = FX_TO_USD[pricing.currency];
  if (fx === undefined) throw new Error(`no exchange rate for currency ${pricing.currency}`);
  const raw = pricing.unit.trim();
  const u = raw.toLowerCase().replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const a = pricing.amount;
  const out = (usdInCurrency: number, assumption: string): MonthlyCost => ({ usd: usdInCurrency * fx, assumption });

  if (/^free/.test(u)) return out(0, "free");

  if (/^percent/.test(u)) {
    const fee = /\+\s*(?:\$|eur\s*)([\d.]+)/.exec(u);
    const fixed = fee ? Number(fee[1]) * U.payments * fx : 0;
    return { usd: (a / 100) * U.paymentVolumeUsd + fixed, assumption: `at $${fmt(U.paymentVolumeUsd)}/month in ${U.payments} payments` };
  }

  // Data volume (before "month", so "GB-month" is storage, not a subscription).
  if (/\b(gb|gib)-month/.test(u)) return out(a * U.gb, `at ${U.gb} GB stored`);
  if (/\b(tb|tib)\b/.test(u)) return out(a * U.tb, `at ${U.tb} TB/month`);
  if (/\b(gb|gib)-second/.test(u)) return out(a * U.gbSeconds, `at ${fmt(U.gbSeconds)} GB-seconds/month`);
  if (/\bgb\b/.test(u)) return out(a * U.gb, `at ${U.gb} GB/month`);

  // Audio and compute time.
  if (/audio hour/.test(u)) return out(a * (U.minutes / 60), `at ${fmt(U.minutes)} audio minutes/month`);
  if (/^per (audio )?minute/.test(u)) return out(a * U.minutes, `at ${fmt(U.minutes)} minutes/month`);
  if (/^per second/.test(u)) return out(a * U.cpuSeconds, `at ${fmt(U.cpuSeconds)} CPU-seconds/month`);

  // Per user (before "month", since "monthly active user" is a count, not a subscription).
  if (/active user|retained user/.test(u)) return out(a * U.users, `at ${fmt(U.users)} monthly active users`);

  // Subscriptions and always-on capacity.
  if (/month/.test(u)) return out(a, "on its flat monthly plan");
  if (/hour\b/.test(u)) return out(a * U.hours, "running all month (730 hours)");
  if (/-day\b/.test(u)) return out(a * U.days, "running all month (30 days)");

  // Per-N counts: "per 1,000,000 requests", "per page", "per 1,000 units of 100 characters".
  const m = /^per ([\d,]+ )?(.+)$/.exec(u);
  if (m) {
    let n = m[1] ? Number(m[1].replace(/,/g, "")) : 1;
    const noun = m[2];
    const hundred = /units of 100 characters/.test(noun);
    if (hundred) n *= 100;
    const kind = KINDS.find(([re]) => re.test(noun));
    if (kind) {
      const [, key, label] = kind;
      const volume = U[key];
      return out((a / n) * volume, `at ${fmt(volume)} ${label}/month`);
    }
  }
  throw new Error(`cannot read price unit "${raw}"`);
}

// L16: characters in one page of text, for translating OCR output (a dense invoice page).
export const CHARS_PER_PAGE = 2_000;

// L15/L16: related units a stated volume can be counted in. For OCR a scanned page is one
// image, and a page of extracted text is about CHARS_PER_PAGE characters.
const EQUIVALENTS: Partial<Record<keyof typeof USAGE, [keyof typeof USAGE, number, string?][]>> = {
  pages: [["images", 1], ["characters", CHARS_PER_PAGE, `at about ${CHARS_PER_PAGE.toLocaleString("en-US")} characters a page`]],
  images: [["pages", 1]],
};

export interface VolumePrice extends MonthlyCost {
  // Set when the volume was converted to the unit the price is in.
  note?: string;
}

// The monthly price at a stated volume, converting the volume to a related unit when the
// service is priced in that unit. Undefined when the volume does not change the price
// (a flat plan, or a unit with no conversion), so the standard estimate stands.
export function priceAtVolume(
  pricing: { amount: number; unit: string; currency: string },
  volume: { amount: number; unit: string }
): VolumePrice | undefined {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const unit = volume.unit as keyof typeof USAGE;
  const tries: [keyof typeof USAGE, number, string | undefined][] = [
    [unit, 1, undefined],
    ...(EQUIVALENTS[unit] ?? []).map(([u, f, how]) => [u, f, how] as [keyof typeof USAGE, number, string | undefined]),
  ];
  for (const [u, factor, how] of tries) {
    const amount = volume.amount * factor;
    const at = monthlyCost(pricing, { [u]: amount });
    // The volume was used if changing it changes the price (a volume equal to the standard
    // profile gives the same assumption text, so that cannot be the test).
    if (monthlyCost(pricing, { [u]: amount + 1 }).usd === at.usd) continue;
    if (u === unit) return at;
    return { ...at, note: `${fmt(volume.amount)} ${volume.unit} counted as ${fmt(amount)} ${u}${how ? `, ${how}` : ""}` };
  }
  return undefined;
}
