// Tamper evidence for the audit trail (T2.4).
//
// Every record of a request stores prevHash (the hash of the request's previous record,
// or GENESIS for the first) and hash = SHA-256 of all its other stored attributes. Editing
// a record changes its hash; deleting or reordering one breaks the next record's
// prevHash; recomputing an edited record's hash still breaks the link to the record after
// it. verifyChain walks a request's records in timestamp order and reports the first break.
import { createHash } from "node:crypto";

export const GENESIS = "GENESIS";

export type AttributeValue = { S?: string; N?: string; BOOL?: boolean };
export type Item = Record<string, AttributeValue>;

// Stable text for an item: attributes sorted by name, the stored hash left out.
function canonical(item: Item): string {
  return JSON.stringify(
    Object.keys(item)
      .filter((k) => k !== "hash")
      .sort()
      .map((k) => {
        const v = item[k];
        const type = Object.keys(v).sort()[0] as keyof AttributeValue;
        return [k, type, v[type]];
      })
  );
}

export function hashItem(item: Item): string {
  return createHash("sha256").update(canonical(item)).digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  // Records whose hash and link were checked.
  checked: number;
  // Records written before the chain existed (no hash), allowed only at the start.
  unchained: number;
  problem?: { index: number; timestamp?: string; reason: string };
}

export function verifyChain(items: Item[]): VerifyResult {
  let checked = 0;
  let unchained = 0;
  let prev: string | undefined;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const timestamp = item.timestamp?.S;
    const stored = item.hash?.S;

    if (!stored) {
      if (prev !== undefined) {
        return { ok: false, checked, unchained, problem: { index: i, timestamp, reason: "record without a hash after the chain started" } };
      }
      unchained++;
      continue;
    }

    const expectedPrev = prev ?? GENESIS;
    if (item.prevHash?.S !== expectedPrev) {
      return {
        ok: false,
        checked,
        unchained,
        problem: { index: i, timestamp, reason: "previous-hash link broken: a record was deleted, inserted or reordered" },
      };
    }
    if (hashItem(item) !== stored) {
      return { ok: false, checked, unchained, problem: { index: i, timestamp, reason: "content does not match its hash: the record was edited" } };
    }
    prev = stored;
    checked++;
  }
  return { ok: true, checked, unchained };
}
