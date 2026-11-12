// T4.1b: price each candidate at the volume the request states (L3), check flat plans'
// quotas against it (L1), and give a per-unit price for limits stated per unit (L2).
import type { ServiceCandidateWithEvidence, UsageVolume } from "@sage/shared-types";
import { USAGE_UNITS } from "@sage/shared-types";
import { monthlyCost } from "@sage/catalogue/src/normalise";

const fmt = (n: number) => n.toLocaleString("en-US");
const round2 = (n: number) => Math.round(n * 100) / 100;

function listed(c: ServiceCandidateWithEvidence) {
  if (typeof c.listPrice !== "number" || !c.priceUnit || !c.currency) return undefined;
  return { amount: c.listPrice, unit: c.priceUnit, currency: c.currency };
}

export interface Priced {
  candidate: ServiceCandidateWithEvidence;
  // Set when the plan cannot serve the volume; the candidate is then not eligible.
  rejectReason?: string;
}

export function priceAtVolume(c: ServiceCandidateWithEvidence, volume?: UsageVolume): Priced {
  if (!volume) return { candidate: c };
  const needed = `${fmt(volume.amount)} ${volume.unit}`;

  if (c.volumeBasis === "quota" && c.includedUnits) {
    const inc = c.includedUnits;
    if (inc.unit !== volume.unit) {
      return { candidate: { ...c, volumeNote: `plan quota is in ${inc.unit}, so ${needed} could not be checked` } };
    }
    if (volume.amount > inc.amount) {
      return { candidate: c, rejectReason: `its plan covers ${fmt(inc.amount)} ${inc.unit} a month, ${needed} needed` };
    }
    return { candidate: { ...c, volumeNote: `plan covers ${fmt(inc.amount)} ${inc.unit} a month, enough for ${needed}` } };
  }
  if (c.volumeBasis === "unmetered") {
    return { candidate: { ...c, volumeNote: "flat price that does not depend on volume" } };
  }
  if (c.volumeBasis === "unknown") {
    return { candidate: { ...c, volumeNote: `plan coverage for ${needed} is not confirmed` } };
  }

  const pricing = listed(c);
  if (!pricing) return { candidate: c };
  try {
    const standard = monthlyCost(pricing);
    const atVolume = monthlyCost(pricing, { [volume.unit]: volume.amount });
    if (atVolume.assumption === standard.assumption) {
      // Priced in another unit (for example per GB): the standard estimate stays.
      return { candidate: { ...c, volumeNote: `priced ${pricing.unit}, so the standard estimate is kept` } };
    }
    return {
      candidate: { ...c, price: round2(atVolume.usd), priceBasis: `estimated USD/month ${atVolume.assumption}` },
    };
  } catch {
    return { candidate: c };
  }
}

// Price of one unit of use, for a limit stated per unit with no volume. Undefined when it
// cannot be told (a flat plan with no quota, or no listed price).
export function unitPrice(c: ServiceCandidateWithEvidence): number | undefined {
  if (c.volumeBasis === "quota" && c.includedUnits) return c.price / c.includedUnits.amount;
  if (c.volumeBasis) return undefined;
  const pricing = listed(c);
  if (!pricing) return undefined;
  try {
    const ones = Object.fromEntries(USAGE_UNITS.map((u) => [u, 1]));
    const standard = monthlyCost(pricing);
    const one = monthlyCost(pricing, ones);
    return one.assumption === standard.assumption ? undefined : one.usd;
  } catch {
    return undefined;
  }
}
